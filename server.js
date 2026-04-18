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
const GORBA_DECIMALS = Number(process.env.GORBA_DECIMALS || "6");
const SHOP_WALLET_PRIVATE_KEY_BASE58 = process.env.SHOP_WALLET_PRIVATE_KEY_BASE58;

if (!RPC_URL || !GORBA_MINT || !RECEIVER_WALLET || !SHOP_WALLET_PRIVATE_KEY_BASE58) {
  throw new Error("Missing required environment variables.");
}

const connection = new Connection(RPC_URL, "confirmed");

const ITEMS = {
  nft1: {
    name: "NFT 1",
    assetId: process.env.NFT1_ASSET_ID,
    price: Number(process.env.NFT1_PRICE || "16000"),
    sold: false,
    soldTo: null,
  },
  nft2: {
    name: "NFT 2",
    assetId: process.env.NFT2_ASSET_ID,
    price: Number(process.env.NFT2_PRICE || "16000"),
    sold: false,
    soldTo: null,
  },
  nft3: {
    name: "NFT 3",
    assetId: process.env.NFT3_ASSET_ID,
    price: Number(process.env.NFT3_PRICE || "16000"),
    sold: false,
    soldTo: null,
  },
  nft4: {
    name: "NFT 4",
    assetId: process.env.NFT4_ASSET_ID,
    price: Number(process.env.NFT4_PRICE || "16000"),
    sold: false,
    soldTo: null,
  },
};

// Remove items that do not have an asset ID yet
for (const key of Object.keys(ITEMS)) {
  if (!ITEMS[key].assetId) {
    delete ITEMS[key];
  }
}

const paymentUsed = new Set();

function getPublicKeyString(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value.toString === "function") return value.toString();
  return null;
}

async function verifyPayment(paymentSignature, buyerWallet, expectedPriceUi) {
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

  const expectedAmount = BigInt(expectedPriceUi) * BigInt(10 ** GORBA_DECIMALS);

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

async function transferCoreAssetToBuyer(assetId, buyerWallet) {
  const secretBytes = bs58.decode(SHOP_WALLET_PRIVATE_KEY_BASE58);

  const umi = createUmi(RPC_URL);
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(secretBytes);
  umi.use(keypairIdentity(umiKeypair));

  const result = await transferV1(umi, {
    asset: publicKey(assetId),
    newOwner: publicKey(buyerWallet),
  }).sendAndConfirm(umi);

  return getPublicKeyString(result.signature) || result.signature;
}

app.get("/", (req, res) => {
  res.send("GORBA backend is live.");
});

app.get("/status", (req, res) => {
  const items = {};

  for (const [itemId, item] of Object.entries(ITEMS)) {
    items[itemId] = {
      name: item.name,
      price: item.price,
      sold: item.sold,
      soldTo: item.soldTo,
    };
  }

  res.status(200).json({
    ok: true,
    items,
  });
});

app.post("/complete-purchase", async (req, res) => {
  try {
    const { buyerWallet, paymentSignature, itemId } = req.body;

    if (!buyerWallet || !paymentSignature || !itemId) {
      return res.status(400).json({
        success: false,
        error: "Missing buyerWallet, paymentSignature, or itemId.",
      });
    }

    const item = ITEMS[itemId];

    if (!item) {
      return res.status(404).json({
        success: false,
        error: "Item not found.",
      });
    }

    if (item.sold) {
      return res.status(409).json({
        success: false,
        error: "This item is already sold.",
      });
    }

    if (paymentUsed.has(paymentSignature)) {
      return res.status(409).json({
        success: false,
        error: "This payment signature has already been used.",
      });
    }

    await verifyPayment(paymentSignature, buyerWallet, item.price);

    const nftSignature = await transferCoreAssetToBuyer(item.assetId, buyerWallet);

    item.sold = true;
    item.soldTo = buyerWallet;
    paymentUsed.add(paymentSignature);

    return res.json({
      success: true,
      itemId,
      nftSignature,
      sold: item.sold,
      soldTo: item.soldTo,
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
  console.log(`GORBA backend running on port ${PORT}`);
});
