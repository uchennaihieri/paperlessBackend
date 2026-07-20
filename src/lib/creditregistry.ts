import { logger } from "./logger";

const BASE_URL       = process.env.CREDITREGISTRY_BASE_URL ?? "https://api.creditregistry.com/nigeria/AutoCred/Live/v8";
const EMAIL          = process.env.CREDITREGISTRY_EMAIL ?? "";
const PASSWORD       = process.env.CREDITREGISTRY_PASSWORD ?? "";
const SUBSCRIBER_ID  = process.env.CREDITREGISTRY_SUBSCRIBERID ?? "";

// ── Session cache (sessions expire in 90 min, refresh at 85 min) ──────────────
interface SessionCache { sessionCode: string; expiresAt: number }
let sessionCache: SessionCache | null = null;

async function getSessionCode(): Promise<string> {
  if (sessionCache && Date.now() < sessionCache.expiresAt) {
    return sessionCache.sessionCode;
  }

  if (!EMAIL || !PASSWORD || !SUBSCRIBER_ID) {
    throw new Error("CREDITREGISTRY_EMAIL / CREDITREGISTRY_PASSWORD / CREDITREGISTRY_SUBSCRIBERID not configured.");
  }

  const res = await fetch(`${BASE_URL}/api/Login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      EmailAddress: EMAIL,
      SubscriberID: SUBSCRIBER_ID,
      Password: PASSWORD,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`CreditRegistry login failed (${res.status}): ${txt}`);
  }

  const data: any = await res.json();
  if (!data.Success) {
    throw new Error(`CreditRegistry login error: ${JSON.stringify(data.Errors)}`);
  }

  const sessionCode = data.SessionCode;
  if (!sessionCode) {
    throw new Error(`CreditRegistry login returned no SessionCode: ${JSON.stringify(data)}`);
  }

  // Sessions last 90 minutes; cache for 85 min
  sessionCache = { sessionCode, expiresAt: Date.now() + 85 * 60 * 1000 };
  logger.info("CreditRegistry: new SessionCode cached");
  return sessionCode;
}

/** Clear session cache so next call re-authenticates */
function clearSession(): void {
  sessionCache = null;
}

// ── Helper: call with auto-retry on auth failure ──────────────────────────────
async function crApiCall<T>(endpoint: string, body: Record<string, any>): Promise<T> {
  let sessionCode = await getSessionCode();
  let res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ ...body, SessionCode: sessionCode }),
  });

  // Retry once on auth failure
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    logger.warn("CreditRegistry: session expired, re-authenticating…");
    clearSession();
    sessionCode = await getSessionCode();
    res = await fetch(`${BASE_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ ...body, SessionCode: sessionCode }),
    });
  }

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`CreditRegistry API error (${res.status}): ${txt}`);
  }

  const data: any = await res.json();
  if (!data.Success) {
    // Check for session-expired error in the body
    const errMsg = JSON.stringify(data.Errors);
    if (errMsg.toLowerCase().includes("session") || errMsg.toLowerCase().includes("login")) {
      logger.warn("CreditRegistry: session error in response, re-authenticating…");
      clearSession();
      sessionCode = await getSessionCode();
      const res2 = await fetch(`${BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ ...body, SessionCode: sessionCode }),
      });
      if (!res2.ok) {
        const txt = await res2.text();
        throw new Error(`CreditRegistry API error on retry (${res2.status}): ${txt}`);
      }
      const data2: any = await res2.json();
      if (!data2.Success) {
        throw new Error(`CreditRegistry API error on retry: ${JSON.stringify(data2.Errors)}`);
      }
      return data2 as T;
    }
    throw new Error(`CreditRegistry API error: ${errMsg}`);
  }

  return data as T;
}

// ── FindSummary ───────────────────────────────────────────────────────────────

export interface CRSearchResult {
  Relevance: number;
  RegistryID: string;
  CorrelationID: string;
  Name: string;
}

interface FindSummaryResponse {
  Success: boolean;
  Errors: any[];
  InfoMessage: string;
  TransactionID: string;
  SearchResult: CRSearchResult[];
}

export async function findSummary(
  bvn: string,
): Promise<{ count: number; searchResult: CRSearchResult[] }> {
  const data = await crApiCall<FindSummaryResponse>("/api/FindSummary", {
    CustomerQuery: bvn,
    GetNoMatchReport: "IfNoMatch",
    MinRelevance: 80,
    MaxRecords: 1,
    EnquiryReason: "KYCCheck",
  });

  logger.info(`CreditRegistry FindSummary: ${data.InfoMessage}`);
  const results = Array.isArray(data.SearchResult) ? data.SearchResult : [];
  return { count: results.length, searchResult: results };
}

// ── GetReport302 ──────────────────────────────────────────────────────────────

export interface CRAccountSummary {
  Currency: string;
  Count_Revolving: number;   Balance_Revolving: number;   CreditLimit_Revolving: number;   Payment_Revolving: number;
  Count_Auto: number;        Balance_Auto: number;        CreditLimit_Auto: number;        Payment_Auto: number;
  Count_Installment: number; Balance_Installment: number; CreditLimit_Installment: number; Payment_Installment: number;
  Count_Mortgage: number;    Balance_Mortgage: number;    CreditLimit_Mortgage: number;    Payment_Mortgage: number;
  Count_Overdraft: number;   Balance_Overdraft: number;   CreditLimit_Overdraft: number;   Minimum_Payment: number;
  Count_Other: number;       Balance_Other: number;       CreditLimit_Other: number;       Payment_Other: number;
  Balance_Total: number;     Count_Total: number;         CreditLimit_Total: number;       Payment_Total: number;
}

export interface CRPerformanceSummary {
  Inquiry_Count_12_Months: string;
  Count_AccountStatus_Closed: string;
  Count_AccountStatus_Delinquent_30_over_60_days: string;
  Count_AccountStatus_Derogatory_Doubtful_180: string;
  Count_AccountStatus_Derogatory_Lost_360: string;
  Count_AccountStatus_Derogatory_Substandard_90: string;
  Count_AccountStatus_Late_less_than_30_days: string;
  Count_AccountStatus_Open: string;
  Count_AccountStatus_Performing: string;
  Count_AccountStatus_Unknown: string;
  Count_AccountStatus_Unspecified: string;
  Count_AccountStatus_Written_off: string;
  Count_LegalStatus_Judgment: string;
  Count_LegalStatus_Litigation: string;
  Count_LegalStatus_Notice: string;
  Count_LegalStatus_Receivership: string;
  SectorExclusionCount: number;
  SectorExclusionMessage: string;
}

interface GetReport302Response {
  Success: boolean;
  Errors: any[];
  InfoMessage: string;
  TransactionID: string;
  SBCs: any[];
  AccountSummaries: CRAccountSummary[];
  PerformanceSummary: CRPerformanceSummary;
}

export async function getReport302(
  registryID: string,
  historyMonths = 12,
): Promise<{ AccountSummaries: CRAccountSummary[]; PerformanceSummary: CRPerformanceSummary }> {
  const data = await crApiCall<GetReport302Response>("/api/GetReport302", {
    CustomerRegistryIDList: [registryID],
    EnquiryReason: "KYCCheck",
    HistoryLengthInMonths: historyMonths,
  });

  logger.info(`CreditRegistry GetReport302 TransactionID: ${data.TransactionID}`);

  // Return only AccountSummaries + PerformanceSummary (skip SBCs)
  return {
    AccountSummaries: data.AccountSummaries ?? [],
    PerformanceSummary: data.PerformanceSummary ?? ({} as CRPerformanceSummary),
  };
}

// ── Combined flow: FindSummary → GetReport302 ─────────────────────────────────

export interface CRCheckResult {
  count: number;
  searchResult: CRSearchResult[];
  subjectName: string;
  report: {
    AccountSummaries: CRAccountSummary[];
    PerformanceSummary: CRPerformanceSummary;
  } | null;
}

export async function findAndReport(bvn: string): Promise<CRCheckResult> {
  const { count, searchResult } = await findSummary(bvn);

  if (count === 0 || searchResult.length === 0) {
    return { count: 0, searchResult: [], subjectName: "", report: null };
  }

  // Best match = highest relevance
  const best = [...searchResult].sort((a, b) => b.Relevance - a.Relevance)[0];
  const subjectName = best.Name ?? "";

  let report: CRCheckResult["report"] = null;
  try {
    report = await getReport302(best.RegistryID);
  } catch (err: any) {
    logger.error(`CreditRegistry GetReport302 failed for RegistryID ${best.RegistryID}:`, err);
    // Continue without report — the search still succeeded
  }

  return { count, searchResult, subjectName, report };
}
