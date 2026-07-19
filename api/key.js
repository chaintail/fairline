// GET /api/key — the feed's signing public key and canonicalization contract.
import { publicKeyInfo } from "../lib/sign.js";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json(publicKeyInfo());
}
