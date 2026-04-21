import { logger } from "./logger";

export interface QoreIDResponse {
  id: number | string;
  applicant: {
    firstname: string;
    lastname: string;
  };
  summary: {
    [key: string]: {
      status: string;
      fieldMatches: Record<string, boolean>;
    };
  };
  status: {
    state: string;
    status: string;
  };
  insight: Array<{
    serviceCategory: string;
    insightCount: number;
    timeframeInMonths: number;
  }>;
  [key: string]: any; // nin or bvn specific field will be here
}

export interface NINVerificationParams {
  firstname: string;
  lastname: string;
  middlename?: string;
  dob?: string;        // YYYY-MM-DD
  phone?: string;
  email?: string;
  gender?: string;
}

export interface BVNVerificationParams {
  firstname: string;
  lastname: string;
  dob?: string;       // YYYY-MM-DD
  phone?: string;
  email?: string;
  gender?: string;
}

// ── Token cache ───────────────────────────────────────────────────────────────

interface TokenCache { token: string; expiresAt: number }
let tokenCache: TokenCache | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const clientId = process.env.QOREID_CLIENT_ID;
  const secret = process.env.QOREID_SECRET_key;
  
  if (!clientId || !secret) {
    logger.error("Missing QoreID Authentication keys in environment");
    throw new Error("Missing QoreID Client ID or Secret Key configuration.");
  }

  const res = await fetch("https://api.qoreid.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/plain"
    },
    body: JSON.stringify({
      clientId,
      secret
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    logger.error(`QoreID token fetch failed: ${errText}`);
    throw new Error(`Failed to fetch QoreID token: ${errText}\nStatus: ${res.status}`);
  }

  const data = await res.json() as any;
  if (!data.accessToken) {
    throw new Error(`Invalid QoreID token response: ${JSON.stringify(data)}`);
  }

  // Token typically expires in seconds
  tokenCache = { 
    token: data.accessToken, 
    expiresAt: Date.now() + (data.expiresIn * 1000) 
  };
  
  return tokenCache.token;
}

const getHeaders = async (): Promise<Record<string, string>> => {
  const token = await getAccessToken();

  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
};

const QOREID_BASE_URL = process.env.QOREID_BASE_URL || "https://api.qoreid.com";

/**
 * Verify a customer's identity using their National Identity Number (NIN).
 * 
 * @param idNumber The 11-digit NIN
 * @param data Verification parameters (firstname, lastname are required)
 * @returns The verification result including matched fields and bio-data
 */
export async function getCustomerNIN(idNumber: string, data: NINVerificationParams): Promise<QoreIDResponse> {
  const url = `${QOREID_BASE_URL}/v1/ng/identities/nin/${encodeURIComponent(idNumber)}`;
  const headers = await getHeaders();

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(data)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logger.error(`QoreID NIN Verification failed for ${idNumber}`, { status: response.status, body: errorBody });
    throw new Error(`QoreID NIN Verification failed with status ${response.status}: ${errorBody}`);
  }

  return response.json() as Promise<QoreIDResponse>;
}

/**
 * Verify a customer's identity using their Bank Verification Number (BVN).
 * 
 * @param idNumber The customer's BVN
 * @param data Verification parameters (firstname, lastname are required)
 * @returns The verification result including matched fields and bio-data snapshot
 */
export async function getCustomerBVN(idNumber: string, data: BVNVerificationParams): Promise<QoreIDResponse> {
  const url = `${QOREID_BASE_URL}/v1/ng/identities/bvn-basic/${encodeURIComponent(idNumber)}`;
  const headers = await getHeaders();

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(data)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logger.error(`QoreID BVN Verification failed for ${idNumber}`, { status: response.status, body: errorBody });
    throw new Error(`QoreID BVN Verification failed with status ${response.status}: ${errorBody}`);
  }

  return response.json() as Promise<QoreIDResponse>;
}
