import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bs58 from "bs58";

import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, publicKey } from "@metaplex-foundation/umi";
import { transferV1 } from "@metaplex-foundation/mpl-core";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3001);

const RPC_URL = process.env.RPC_URL;
const GORBA_MINT = process.env.GORBA_MINT;
const RECEIVER_WALLET = process.env.RECEIVER_WALLET;
const GORBA_PRICE = Number(process.env.GORBA_PRICE || "16000");
const GORBA_DECIMALS = Number(process.env.GORBA_DECIMALS || "6");
const CORE_ASSET_ID = process.env.CORE_ASSET_ID;
const SHOP_WALLET_PRIVATE_KEY_BASE58 = process.env.SHOP_WALLET_PRIVATE_KEY_BASE58;

if (
  !RPC_URL ||
  !GORBA_MINT ||
  !RECEIVER_WALLET ||
  !CORE_ASSET_ID ||
  !SHOP_WALLET_PRIVATE_KEY_BASE58
) {
  throw new Error("Missing required environment variables.");
}

const connection = new Connection(RPC_URL, "confirmed");

let nftSold = false;
let soldTo = null;
let paymentUsed = new Set();

function getExpectedAmountBaseUnits() {
  return BigInt(GORBA_PRICE) * BigInt(10 ** GORBA_DECIMALS);
}

function getPublicKeyString(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value.toString === "function") return value.toString();
  return null;
}

async function verifyPayment(paymentSignature, buyerWallet) {
  const tx = await connection.getParsedTransaction(paymentSignature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) {
    throw new Error("Payment transaction not found.");
  }

  const buyerAta = getAssociatedTokenAddressSync(
    new PublicKey(GORBA_MINT),
    new PublicKey(buyerWallet)
  ).toBase58();

  const receiverAta = getAssociatedTokenAddressSync(
    new PublicKey(GORBA_MINT),
    new PublicKey(RECEIVER_WALLET)
  ).toBase58();

  const expectedAmount = getExpectedAmountBaseUnits();

  let validPayment = false;

  for (const ix of tx.transaction.message.instructions) {
    if (!("parsed" in ix) || !ix.parsed) continue;

    const parsed = ix.parsed;
    if (!parsed || typeof parsed !== "object") continue;

    if (parsed.type !== "transferChecked" && parsed.type !== "transfer") {
      continue;
    }

    const info = parsed.info || {};
    const source = info.source;
    const destination = info.destination;
    const authority = info.authority || info.multisigAuthority;
    const mint = info.mint || GORBA_MINT;

    let amountRaw = null;

    if (info.tokenAmount && info.tokenAmount.amount) {
      amountRaw = info.tokenAmount.amount;
    } else if (info.amount) {
      amountRaw = info.amount;
    }

    if (
      source === buyerAta &&
      destination === receiverAta &&
      authority === buyerWallet &&
      mint === GORBA_MINT &&
      amountRaw &&
      BigInt(amountRaw) === expectedAmount
    ) {
      validPayment = true;
      break;
    }
  }

  if (!validPayment) {
    throw new Error("Payment does not match required $GORBA transfer.");
  }

  return true;
}

async function transferCoreAssetToBuyer(buyerWallet) {
  const secretBytes = bs58.decode(SHOP_WALLET_PRIVATE_KEY_BASE58);

  const umi = createUmi(RPC_URL);
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(secretBytes);
  umi.use(keypairIdentity(umiKeypair));

  const result = await transferV1(umi, {
    asset: publicKey(CORE_ASSET_ID),
    newOwner: publicKey(buyerWallet),
  }).sendAndConfirm(umi);

  return getPublicKeyString(result.signature) || result.signature;
}
app.get("/", (req, res) => {
  res.status(200).send("GORBA backend is live.");
});

app.get("/status", (req, res) => {
  console.log("STATUS ROUTE HIT");
  res.status(200).json({
    ok: true,
    sold: nftSold,
    soldTo: soldTo,
  });
});

app.post("/complete-purchase", async (req, res) => {
  try {
    const { buyerWallet, paymentSignature } = req.body;

    if (!buyerWallet || !paymentSignature) {
      return res.status(400).json({
        success: false,
        error: "Missing buyerWallet or paymentSignature.",
      });
    }

    if (nftSold) {
      return res.status(409).json({
        success: false,
        error: "NFT already sold.",
      });
    }

    if (paymentUsed.has(paymentSignature)) {
      return res.status(409).json({
        success: false,
        error: "This payment signature has already been used.",
      });
    }

    await verifyPayment(paymentSignature, buyerWallet);

    const nftSignature = await transferCoreAssetToBuyer(buyerWallet);

    nftSold = true;
    soldTo = buyerWallet;
    paymentUsed.add(paymentSignature);

    return res.json({
      success: true,
      nftSignature,
      sold: true,
      soldTo,
    });
  } catch (error) {
    console.error("complete-purchase error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Server error.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`GORBA backend running on http://localhost:${PORT}`);
});