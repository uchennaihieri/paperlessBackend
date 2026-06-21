import { logger } from "./logger";

const BASE_URL = process.env.FIRSTCENTRAL_BASE_URL ?? "https://uat.firstcentralcreditbureau.com/firstcentralrestv2";
const USERNAME = process.env.FIRSTCENTRAL_USERNAME ?? "";
const PASSWORD = process.env.FIRSTCENTRAL_PASSWORD ?? "";




// ── Token cache (tickets expire in 5 h, refresh at 4 h 50 m) ─────────────────
interface TicketCache { ticket: string; expiresAt: number }
let ticketCache: TicketCache | null = null;

async function getDataTicket(): Promise<string> {
  if (ticketCache && Date.now() < ticketCache.expiresAt - 60_000) {
    return ticketCache.ticket;
  }

  if (!USERNAME || !PASSWORD) {
    throw new Error("FIRSTCENTRAL_USERNAME / FIRSTCENTRAL_PASSWORD not configured.");
  }

  const res = await fetch(`${BASE_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`FirstCentral login failed (${res.status}): ${txt}`);
  }

  const data: any = await res.json();
  // The API returns an ARRAY: [{"DataTicket":"..."}]
  const ticket = Array.isArray(data) ? data[0]?.DataTicket : data?.DataTicket;
  if (!ticket) {
    throw new Error(`FirstCentral login returned no DataTicket: ${JSON.stringify(data)}`);
  }

  // Tickets last 5 hours; cache for 4 h 50 m
  ticketCache = { ticket, expiresAt: Date.now() + (4 * 60 + 50) * 60 * 1000 };
  logger.info("FirstCentral: new DataTicket cached");
  return ticketCache.ticket;
}

// ── Consumer Match ─────────────────────────────────────────────────────────────

export interface ConsumerMatchResult {
  MatchingEngineID: string;
  EnquiryID: string;
  ConsumerID: string;
  Reference: string;
  IDNo: string | null;
  FirstName: string | null;
  Surname: string | null;
  SecondName: string | null;
  OtherNames: string | null;
  Address: string | null;
  BirthDate: string | null;
  GenderInd: string | null;
  TelePhoneNumber: string | null;
  MatchingRate: string;
  [key: string]: any;
}

const isLive = BASE_URL.includes("online.firstcentralcreditbureau.com");



function sanitizeEnquiryReason(reason: string): string {
  if (!isLive) return reason; // Test environment accepts "Test", "Credit Check", etc.

  // As requested, use ONLY this specific reason in the live environment
  return "credit scoring of the client by credit bureau";
}

export async function consumerMatchByBvn(
  bvn: string,
  enquiryReason = "Credit Check",
  productId = 45
): Promise<{ count: number; matched: ConsumerMatchResult[] }> {
  const ticket = await getDataTicket();

  const res = await fetch(`${BASE_URL}/ConnectConsumerMatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      DataTicket: ticket,       // must be in the body per FC docs
      EnquiryReason: sanitizeEnquiryReason(enquiryReason),
      ConsumerName: "",
      DateOfBirth: "",
      Identification: bvn,         // BVN goes in Identification field
      Accountno: "",
      ProductID: String(productId),
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    logger.error(`FirstCentral ConsumerMatch failed: ${txt}`);
    throw new Error(`FirstCentral API error (${res.status}): ${txt}`);
  }

  const raw: any = await res.json();

  // Normalise: the API returns [{"MatchedConsumer":[...]}]
  const list: ConsumerMatchResult[] = Array.isArray(raw)
    ? (raw[0]?.MatchedConsumer ?? raw[0]?.MatchedConsumers ?? raw)
    : Array.isArray(raw?.MatchedConsumer)
      ? raw.MatchedConsumer
      : raw?.MatchedConsumers ?? [];

  return { count: list.length, matched: list };
}

// ── Consumer Detailed Credit Report ───────────────────────────────────────────
// Requires ConsumerID, EnquiryID and MatchingEngineID from a prior match call.

export async function getConsumerDetailedCreditReport(opts: {
  consumerID: string;
  enquiryID: string;
  subscriberEnquiryEngineID: string; // = MatchingEngineID from match response
  consumerMergeList?: string;        // defaults to consumerID
  productId?: number;                // defaults to 45
}): Promise<any> {
  const ticket = await getDataTicket();
  const {
    consumerID, enquiryID, subscriberEnquiryEngineID,
    consumerMergeList = consumerID,
    productId = 45,
  } = opts;

  const res = await fetch(`${BASE_URL}/GetConsumerFullCreditReport`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      DataTicket: ticket,
      consumerID,
      EnquiryID: enquiryID,
      consumerMergeList,
      SubscriberEnquiryEngineID: subscriberEnquiryEngineID,
      productid: productId,   // number, not string
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    logger.error(`FirstCentral DetailedCreditReport failed: ${txt}`);
    throw new Error(`FirstCentral API error (${res.status}): ${txt}`);
  }

  const raw: any = await res.json();
  // Unwrap array wrapper if present
  const payload = Array.isArray(raw) ? raw[0] : raw;

  // FirstCentral returns a {SubjectList:[...]} disambiguation page when
  // multiple consumers could match. Re-call with the merged consumerID list
  // to get the actual credit report.
  if (payload?.SubjectList && Array.isArray(payload.SubjectList) && payload.SubjectList.length > 0) {
    logger.info(`FirstCentral SubjectList received (${payload.SubjectList.length} subjects) — resolving to full report`);
    const mergeList = payload.SubjectList.map((s: any) => s.ConsumerID ?? s.Reference).filter(Boolean).join(",");

    const res2 = await fetch(`${BASE_URL}/GetConsumerFullCreditReport`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        DataTicket: ticket,
        consumerID,
        EnquiryID: enquiryID,
        consumerMergeList: mergeList,
        SubscriberEnquiryEngineID: subscriberEnquiryEngineID,
        // productid is NOT a valid field for /GetConsumerFullCreditReport
      }),
    });

    if (!res2.ok) {
      const txt = await res2.text();
      logger.error(`FirstCentral DetailedCreditReport (resolved) failed: ${txt}`);
      throw new Error(`FirstCentral API error (${res2.status}): ${txt}`);
    }

    const raw2: any = await res2.json();
    const payload2 = Array.isArray(raw2) ? raw2[0] : raw2;
    logger.info(`FirstCentral report (resolved) keys: ${JSON.stringify(Object.keys(payload2 ?? {}))}`);
    logger.info(`FirstCentral report (resolved) full: ${JSON.stringify(payload2)}`);
    return payload2;
  }

  return payload;
}
