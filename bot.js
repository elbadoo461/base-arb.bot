/**
 * base-arb.bot — Production Arbitrage/Sweeper Bot
 * ─────────────────────────────────────────────────
 * Chain   : Base Mainnet (chainId 8453)
 * DEXes   : Uniswap V3 (0.05% pool) × Aerodrome Finance (stable pool)
 * Pair    : WETH / cbETH
 * Runtime : Node.js 20+, ethers.js v6
 *
 * Architecture
 * ────────────
 *  • Hybrid provider  — JsonRpcProvider (HTTP) for polling + WebSocketProvider
 *                       for block-event subscription. Falls back to HTTP-only
 *                       if WSS is unavailable.
 *  • KeepAlive        — 20-second heartbeat ping prevents RPC idle-timeout.
 *  • Exponential back-off — 1 s → 2 s → 5 s (capped) on disconnect/error.
 *  • Rate-limit guard — 2 000 ms minimum between quote calls; 429 responses
 *                       trigger a 10-second pause before resuming.
 *  • Memory-safe      — No global state accumulation; listeners are removed
 *                       before re-attaching on reconnect.
 *  • Health server    — Spawns health-server.js as a background worker so
 *                       Railway's HTTP health-check always gets a 200 OK.
 */

"use strict";

require("dotenv").config();
const { ethers } = require("ethers");
const { Worker }  = require("worker_threads");
const path        = require("path");

// ─── Environment ────────────────────────────────────────────────────────────

const RPC_HTTP = process.env.RPC_HTTP_URL;
const RPC_WSS  = process.env.RPC_WSS_URL;   // optional but recommended

if (!RPC_HTTP) {
  console.error("❌  FATAL: RPC_HTTP_URL is not set. Exiting.");
  process.exit(1);
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CHAIN_ID          = 8453;
const POLL_INTERVAL_MS  = 2_000;   // 2 s between quote fetches (rate-limit guard)
const HEARTBEAT_MS      = 20_000;  // 20 s keepAlive ping
const RATE_LIMIT_PAUSE  = 10_000;  // 10 s back-off on HTTP 429
const BACKOFF_SCHEDULE  = [1_000, 2_000, 5_000]; // reconnect delays (ms)

// Trade sizing
const TRADE_SIZE_ETH    = process.env.TRADE_SIZE_ETH
  ? ethers.parseEther(process.env.TRADE_SIZE_ETH)
  : ethers.parseEther("1.0");

// Minimum net profit threshold (USD) before a strike is considered
const MIN_NET_PROFIT_USD = parseFloat(process.env.MIN_NET_PROFIT_USD || "2.0");

// ─── Contract Addresses (Base Mainnet) ───────────────────────────────────────

const ADDR = {
  WETH  : "0x4200000000000000000000000000000000000006",
  cbETH : "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",

  // Uniswap V3 — WETH/cbETH 0.05 % pool
  UNI_QUOTER_V2 : "0x3d4e44Eb1374240CE5F1B136588e34D26d9F9a5",

  // Aerodrome Finance — stable pool WETH/cbETH
  AERO_POOL     : process.env.AERO_POOL_ADDRESS
                  || "0x44Cccbbd7A19A24b929Af4e3F09248B4B4E6f1f4",

  // Executor contract (optional — only needed for live strikes)
  EXECUTOR      : process.env.EXECUTOR_CONTRACT || "",
};

// ─── ABIs (minimal) ──────────────────────────────────────────────────────────

const ABI_UNI_QUOTER = [
  // quoteExactInputSingle((tokenIn,tokenOut,amountIn,fee,sqrtPriceLimitX96))
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const ABI_AERO_POOL = [
  // Aerodrome stable pool — getAmountOut(amountIn, tokenIn)
  "function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256)",
];

const ABI_EXECUTOR = [
  "function strike(uint8 strategyId, uint256 amount, uint256 minAmountOut) external",
];

// ─── State ───────────────────────────────────────────────────────────────────

let httpProvider  = null;
let wssProvider   = null;
let uniQuoter     = null;
let aeroPool      = null;
let executor      = null;
let wallet        = null;

let heartbeatTimer   = null;
let reconnectAttempt = 0;
let isRateLimited    = false;
let lastPollTime     = 0;
let isShuttingDown   = false;

// ─── Logging helpers ─────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}

function log(emoji, tag, msg) {
  console.log(`${ts()}  ${emoji}  [${tag}]  ${msg}`);
}

function logBlock(blockNum) {
  log("🧱", "BLOCK", `#${blockNum}`);
}

function logQuote(dex, amountIn, amountOut, token) {
  const inF  = ethers.formatEther(amountIn);
  const outF = ethers.formatEther(amountOut);
  log("💬", "QUOTE", `${dex}  ${inF} WETH → ${outF} ${token}`);
}

function logReject(reason, spreadPct, netUsd) {
  log(
    "🚫", "REJECT",
    `${reason}  |  spread=${spreadPct.toFixed(4)}%  net=$${netUsd.toFixed(4)}`
  );
}

function logOpportunity(direction, spreadPct, netUsd) {
  log(
    "🚀", "OPPORTUNITY",
    `${direction}  |  spread=${spreadPct.toFixed(4)}%  net=$${netUsd.toFixed(4)}`
  );
}

// ─── Provider bootstrap ──────────────────────────────────────────────────────

function buildHttpProvider() {
  const p = new ethers.JsonRpcProvider(RPC_HTTP, CHAIN_ID, {
    staticNetwork : ethers.Network.from(CHAIN_ID),
    polling       : true,
    pollingInterval: POLL_INTERVAL_MS,
  });
  log("🔌", "HTTP", `Provider connected → ${RPC_HTTP.slice(0, 40)}…`);
  return p;
}

async function buildWssProvider() {
  if (!RPC_WSS) return null;
  try {
    const p = new ethers.WebSocketProvider(RPC_WSS, CHAIN_ID);
    // Wait for the first block to confirm the connection is live
    await Promise.race([
      p.getBlockNumber(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("WSS timeout")), 8_000)),
    ]);
    log("🔌", "WSS", `Provider connected → ${RPC_WSS.slice(0, 40)}…`);
    return p;
  } catch (err) {
    log("⚠️ ", "WSS", `Could not connect (${err.message}) — falling back to HTTP polling`);
    return null;
  }
}

// ─── Contract handles ────────────────────────────────────────────────────────

function buildContracts(provider) {
  uniQuoter = new ethers.Contract(ADDR.UNI_QUOTER_V2, ABI_UNI_QUOTER, provider);
  aeroPool  = new ethers.Contract(ADDR.AERO_POOL,     ABI_AERO_POOL,  provider);

  if (ADDR.EXECUTOR && wallet) {
    executor = new ethers.Contract(ADDR.EXECUTOR, ABI_EXECUTOR, wallet);
  }
}

// ─── Wallet ──────────────────────────────────────────────────────────────────

function buildWallet(provider) {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    log("⚠️ ", "WALLET", "PRIVATE_KEY not set — running in read-only / scan-only mode");
    return null;
  }
  return new ethers.Wallet(pk, provider);
}

// ─── KeepAlive heartbeat ─────────────────────────────────────────────────────

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    try {
      const block = await httpProvider.getBlockNumber();
      log("💓", "HEARTBEAT", `block #${block}`);
    } catch (err) {
      log("⚠️ ", "HEARTBEAT", `ping failed — ${err.message}`);
    }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref(); // don't prevent process exit
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ─── Rate-limit guard ────────────────────────────────────────────────────────

function isRateLimitError(err) {
  const msg = (err?.message || "").toLowerCase();
  const code = err?.status || err?.code;
  return code === 429 || msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
}

async function rateLimitedCall(fn) {
  if (isRateLimited) {
    log("⏸️ ", "RATE_LIMIT", "Paused — waiting for cool-down");
    return null;
  }

  // Enforce minimum polling interval
  const now  = Date.now();
  const wait = POLL_INTERVAL_MS - (now - lastPollTime);
  if (wait > 0) await sleep(wait);
  lastPollTime = Date.now();

  try {
    return await fn();
  } catch (err) {
    if (isRateLimitError(err)) {
      isRateLimited = true;
      log("🔴", "RATE_LIMIT", `HTTP 429 — pausing ${RATE_LIMIT_PAUSE / 1000}s`);
      setTimeout(() => {
        isRateLimited = false;
        log("🟢", "RATE_LIMIT", "Cool-down complete — resuming");
      }, RATE_LIMIT_PAUSE);
      return null;
    }
    throw err;
  }
}

// ─── Quote helpers ───────────────────────────────────────────────────────────

/**
 * Fetch Uniswap V3 quote: WETH → cbETH (0.05 % pool)
 * Uses staticCall so no gas is spent.
 */
async function quoteUniswap(amountIn) {
  const params = {
    tokenIn           : ADDR.WETH,
    tokenOut          : ADDR.cbETH,
    amountIn          : amountIn,
    fee               : 500,   // 0.05 %
    sqrtPriceLimitX96 : 0n,
  };
  const [amountOut] = await uniQuoter.quoteExactInputSingle.staticCall(params);
  return amountOut;
}

/**
 * Fetch Aerodrome stable-pool quote: WETH → cbETH
 */
async function quoteAerodrome(amountIn) {
  return await aeroPool.getAmountOut(amountIn, ADDR.WETH);
}

// ─── Arbitrage scan ──────────────────────────────────────────────────────────

/**
 * Fetch ETH price in USD from a simple on-chain Chainlink feed (optional).
 * Falls back to a hard-coded estimate if the feed is unavailable.
 */
async function getEthPriceUsd() {
  try {
    // Chainlink ETH/USD on Base
    const feed = new ethers.Contract(
      "0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70",
      ["function latestAnswer() external view returns (int256)"],
      httpProvider
    );
    const raw = await feed.latestAnswer();
    return Number(raw) / 1e8;
  } catch {
    return 2_500; // fallback estimate
  }
}

async function scanOnce(blockNumber) {
  if (isRateLimited) return;

  log("🔍", "SCAN", `Checking block #${blockNumber}…`);

  // ── Fetch quotes ──────────────────────────────────────────────────────────

  let uniOut, aeroOut;

  try {
    uniOut = await rateLimitedCall(() => quoteUniswap(TRADE_SIZE_ETH));
    if (uniOut == null) return;
    logQuote("UNISWAP_V3", TRADE_SIZE_ETH, uniOut, "cbETH");
  } catch (err) {
    log("⚠️ ", "UNISWAP", `Quote failed — ${err.message}`);
    return;
  }

  try {
    aeroOut = await rateLimitedCall(() => quoteAerodrome(TRADE_SIZE_ETH));
    if (aeroOut == null) return;
    logQuote("AERODROME ", TRADE_SIZE_ETH, aeroOut, "cbETH");
  } catch (err) {
    log("⚠️ ", "AERODROME", `Quote failed — ${err.message}`);
    return;
  }

  // ── Spread calculation ────────────────────────────────────────────────────

  // Both quotes are in cbETH (18 decimals). Higher output = better buy price.
  const uniF  = parseFloat(ethers.formatEther(uniOut));
  const aeroF = parseFloat(ethers.formatEther(aeroOut));

  let buyDex, sellDex, buyOut, sellOut;
  if (uniF >= aeroF) {
    // Buy cbETH on Uniswap (more cbETH per WETH), sell on Aerodrome
    buyDex  = "UNISWAP_V3";
    sellDex = "AERODROME ";
    buyOut  = uniF;
    sellOut = aeroF;
  } else {
    // Buy cbETH on Aerodrome, sell on Uniswap
    buyDex  = "AERODROME ";
    sellDex = "UNISWAP_V3";
    buyOut  = aeroF;
    sellOut = uniF;
  }

  const spreadPct = ((buyOut - sellOut) / sellOut) * 100;

  // ── Cost estimation ───────────────────────────────────────────────────────

  const ethPriceUsd = await getEthPriceUsd();
  const tradeEth    = parseFloat(ethers.formatEther(TRADE_SIZE_ETH));

  // Gross profit in ETH terms (cbETH ≈ 1 ETH for spread purposes)
  const grossEth    = (buyOut - sellOut);
  const grossUsd    = grossEth * ethPriceUsd;

  // Gas estimate: ~350 000 gas @ current base fee
  let gasPriceGwei  = 0.001; // Base chain is very cheap
  try {
    const feeData   = await httpProvider.getFeeData();
    gasPriceGwei    = parseFloat(ethers.formatUnits(feeData.gasPrice || 1n, "gwei"));
  } catch { /* non-fatal */ }

  const GAS_UNITS   = 350_000;
  const gasCostEth  = (gasPriceGwei * GAS_UNITS) / 1e9;
  const gasCostUsd  = gasCostEth * ethPriceUsd;

  // Slippage: 0.1 % of trade size on each leg
  const slippagePct = 0.001;
  const slippageUsd = tradeEth * ethPriceUsd * slippagePct * 2;

  const totalCostUsd = gasCostUsd + slippageUsd;
  const netUsd       = grossUsd - totalCostUsd;

  log(
    "📊", "MATH",
    `spread=${spreadPct.toFixed(4)}%  gross=$${grossUsd.toFixed(4)}` +
    `  gas=$${gasCostUsd.toFixed(4)}  slip=$${slippageUsd.toFixed(4)}` +
    `  net=$${netUsd.toFixed(4)}  ETH_USD=$${ethPriceUsd.toFixed(0)}`
  );

  // ── Decision ──────────────────────────────────────────────────────────────

  if (spreadPct <= 0) {
    logReject("SPREAD_NEGATIVE", spreadPct, netUsd);
    return;
  }

  if (netUsd < MIN_NET_PROFIT_USD) {
    logReject(
      `NET_PROFIT_BELOW_THRESHOLD ($${MIN_NET_PROFIT_USD})`,
      spreadPct,
      netUsd
    );
    return;
  }

  // ── Opportunity found! ────────────────────────────────────────────────────

  logOpportunity(`BUY_${buyDex.trim()} → SELL_${sellDex.trim()}`, spreadPct, netUsd);

  if (!executor || !wallet) {
    log("ℹ️ ", "STRIKE", "No executor contract / wallet — scan-only mode, skipping execution");
    return;
  }

  await executeStrike(netUsd);
}

// ─── Strike execution ────────────────────────────────────────────────────────

async function executeStrike(estimatedNetUsd) {
  log("⚡", "STRIKE", `Initiating strike — estimated net $${estimatedNetUsd.toFixed(4)}`);
  try {
    const minOut = 0n; // TODO: set slippage-protected minAmountOut
    const tx = await executor.strike(0, TRADE_SIZE_ETH, minOut, {
      gasLimit: 500_000n,
    });
    log("📡", "TX_BROADCAST", `txHash: ${tx.hash}`);
    log("🔗", "BASESCAN", `https://basescan.org/tx/${tx.hash}`);

    const receipt = await tx.wait(1);
    if (receipt.status === 1) {
      log("✅", "TX_CONFIRMED", `block #${receipt.blockNumber}  gasUsed=${receipt.gasUsed}`);
    } else {
      log("❌", "TX_REVERTED", `block #${receipt.blockNumber}`);
    }
  } catch (err) {
    log("❌", "STRIKE_FAILED", err.message);
  }
}

// ─── Block listener ──────────────────────────────────────────────────────────

function attachBlockListener(provider) {
  // Remove any existing listener to avoid duplicates
  provider.removeAllListeners("block");

  provider.on("block", async (blockNumber) => {
    logBlock(blockNumber);
    try {
      await scanOnce(blockNumber);
    } catch (err) {
      log("⚠️ ", "SCAN_ERROR", err.message);
    }
  });

  log("👂", "LISTENER", `Block listener attached (${provider instanceof ethers.WebSocketProvider ? "WSS" : "HTTP"})`);
}

// ─── Reconnect logic ─────────────────────────────────────────────────────────

async function reconnect() {
  if (isShuttingDown) return;

  const delay = BACKOFF_SCHEDULE[Math.min(reconnectAttempt, BACKOFF_SCHEDULE.length - 1)];
  reconnectAttempt++;

  log("🔄", "RECONNECT", `Attempt #${reconnectAttempt} — waiting ${delay / 1000}s…`);
  await sleep(delay);

  try {
    await bootstrap();
    reconnectAttempt = 0; // reset on success
    log("✅", "RECONNECT", "Successfully reconnected");
  } catch (err) {
    log("❌", "RECONNECT", `Failed — ${err.message}`);
    reconnect(); // schedule next attempt (not recursive-blocking — returns immediately)
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function bootstrap() {
  // Tear down existing providers cleanly
  stopHeartbeat();

  if (wssProvider) {
    try { wssProvider.removeAllListeners(); wssProvider.destroy(); } catch { /* ignore */ }
    wssProvider = null;
  }
  if (httpProvider) {
    try { httpProvider.removeAllListeners(); } catch { /* ignore */ }
    httpProvider = null;
  }

  // Build fresh providers
  httpProvider = buildHttpProvider();
  wssProvider  = await buildWssProvider();

  // Wallet (uses HTTP provider for signing)
  wallet = buildWallet(httpProvider);

  // Contracts
  buildContracts(httpProvider);

  // Verify connectivity
  const blockNum = await httpProvider.getBlockNumber();
  log("✅", "CONNECTED", `Base Mainnet — latest block #${blockNum}`);

  // Attach block listener — prefer WSS, fall back to HTTP
  const listenerProvider = wssProvider || httpProvider;
  attachBlockListener(listenerProvider);

  // Wire up disconnect/error handlers
  if (wssProvider) {
    wssProvider.websocket.on("close", (code) => {
      log("🔌", "WSS_CLOSE", `code=${code} — scheduling reconnect`);
      reconnect();
    });
    wssProvider.websocket.on("error", (err) => {
      log("⚠️ ", "WSS_ERROR", err.message);
    });
  }

  httpProvider.on("error", (err) => {
    log("⚠️ ", "HTTP_ERROR", err.message);
    if (isRateLimitError(err)) {
      isRateLimited = true;
      setTimeout(() => { isRateLimited = false; }, RATE_LIMIT_PAUSE);
    }
  });

  // Start keepAlive heartbeat
  startHeartbeat();
}

// ─── Health-check worker ─────────────────────────────────────────────────────

function startHealthServer() {
  const workerPath = path.join(__dirname, "health-server.js");
  const worker = new Worker(workerPath);

  worker.on("online",  ()    => log("🏥", "HEALTH_SERVER", "HTTP server online on port 8080"));
  worker.on("error",   (err) => log("⚠️ ", "HEALTH_SERVER", `Worker error — ${err.message}`));
  worker.on("exit",    (code) => {
    if (!isShuttingDown) {
      log("⚠️ ", "HEALTH_SERVER", `Worker exited (code ${code}) — restarting`);
      setTimeout(startHealthServer, 2_000);
    }
  });

  return worker;
}

// ─── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown(signal) {
  log("🛑", "SHUTDOWN", `Received ${signal} — shutting down gracefully`);
  isShuttingDown = true;
  stopHeartbeat();

  if (wssProvider) {
    try { wssProvider.removeAllListeners(); wssProvider.destroy(); } catch { /* ignore */ }
  }
  if (httpProvider) {
    try { httpProvider.removeAllListeners(); } catch { /* ignore */ }
  }

  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  log("💥", "UNCAUGHT", err.message);
  if (!isShuttingDown) reconnect();
});

process.on("unhandledRejection", (reason) => {
  log("💥", "UNHANDLED_REJECTION", String(reason));
});

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entry point ─────────────────────────────────────────────────────────────

(async () => {
  log("🤖", "STARTUP", "base-arb.bot initialising…");
  log("📋", "CONFIG", [
    `TRADE_SIZE=${ethers.formatEther(TRADE_SIZE_ETH)} ETH`,
    `MIN_NET_PROFIT=$${MIN_NET_PROFIT_USD}`,
    `POLL_INTERVAL=${POLL_INTERVAL_MS}ms`,
    `HEARTBEAT=${HEARTBEAT_MS}ms`,
    `RATE_LIMIT_PAUSE=${RATE_LIMIT_PAUSE}ms`,
  ].join("  |  "));

  // Start health-check HTTP server in a background worker thread
  startHealthServer();

  // Bootstrap providers and begin scanning
  try {
    await bootstrap();
  } catch (err) {
    log("❌", "BOOTSTRAP_FAILED", err.message);
    reconnect();
  }
})();
