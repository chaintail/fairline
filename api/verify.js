// POST /api/verify — verify a FairLine envelope (body = the signed envelope).
// Deterministic validation: any consumer can do the same offline with the
// public key from /api/key; this endpoint is a convenience reference
// implementation (see lib/sign.js verifyEnvelope).
import { verifyEnvelope } from "../lib/sign.js";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST a signed envelope" });
    return;
  }
  try {
    const envelope = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    res.status(200).json(verifyEnvelope(envelope));
  } catch (e) {
    res.status(400).json({ valid: false, reason: "unparseable body: " + e.message });
  }
}
