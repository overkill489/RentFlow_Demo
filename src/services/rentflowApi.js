const API_URL = (
  import.meta.env.VITE_API_URL || "http://localhost:5000"
).replace(/\/$/, "");

let accessToken = null;
let expirationTimer = null;

const sessionListeners = new Set();

function notifySessionExpired() {
  for (const listener of sessionListeners) {
    listener();
  }
}

function clearExpirationTimer() {
  if (expirationTimer !== null) {
    clearTimeout(expirationTimer);
    expirationTimer = null;
  }
}

function clearSession(notify = false) {
  const hadSession = Boolean(accessToken);

  accessToken = null;
  clearExpirationTimer();

  if (notify && hadSession) {
    notifySessionExpired();
  }
}

function getTokenExpiration(token) {
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );

    if (!Number.isFinite(payload.exp)) {
      return null;
    }

    return payload.exp * 1000;
  } catch {
    return null;
  }
}

function setSession(token) {
  clearSession();

  const expiresAt = getTokenExpiration(token);

  if (!expiresAt || expiresAt <= Date.now()) {
    throw new Error("Received an invalid or expired session.");
  }

  accessToken = token;

  expirationTimer = setTimeout(
    () => {
      clearSession(true);
    },
    Math.max(0, expiresAt - Date.now()),
  );
}

async function request(path, options = {}) {
  const tokenForRequest = accessToken;
  const headers = new Headers(options.headers);

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  if (tokenForRequest) {
    headers.set("Authorization", `Bearer ${tokenForRequest}`);
  }

  let response;

  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers,
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "Cannot connect to RentFlow API. Check that the backend is running.",
    );
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    if (
      response.status === 401 &&
      tokenForRequest &&
      accessToken === tokenForRequest
    ) {
      clearSession(true);
    }

    const error = new Error(
      payload?.error || `Request failed with status ${response.status}`,
    );

    error.status = response.status;

    throw error;
  }

  return payload;
}

export const rentflowApi = {
  onSessionExpired(listener) {
    sessionListeners.add(listener);

    return () => {
      sessionListeners.delete(listener);
    };
  },

  async login(email, password) {
    clearSession();

    const result = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });

    setSession(result.token);

    return result.user;
  },

  async logout() {
    if (!accessToken) {
      clearSession();
      return {
        success: true,
        message: "Local session cleared",
      };
    }

    try {
      return await request("/api/auth/logout", {
        method: "POST",
      });
    } finally {
      clearSession();
    }
  },

  async getCurrentUser() {
    const result = await request("/api/auth/me");
    return result.user;
  },

  async getQuotes() {
    const result = await request("/api/quotes");
    return result.data;
  },

  async getQuote(id) {
    const result = await request(`/api/quotes/${encodeURIComponent(id)}`);

    return result.data;
  },

  async createQuote(quote) {
    const result = await request("/api/quotes", {
      method: "POST",
      body: JSON.stringify(quote),
    });

    return result.data;
  },

  async updateQuoteStatus(id, status) {
    const result = await request(`/api/quotes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });

    return result.data;
  },

  async getFollowUps() {
    const result = await request("/api/followups");
    return result.data;
  },

  async getActivity(id) {
    const result = await request(
      `/api/followups/quotes/${encodeURIComponent(id)}/activity`,
    );

    return result.data;
  },

  async scheduleFollowUp(id, scheduledAt) {
    return request(`/api/followups/quotes/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ scheduledAt }),
    });
  },

  async cancelFollowUp(id) {
    return request(`/api/followups/quotes/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  async simulateFollowUp(id) {
    return request(`/api/followups/quotes/${encodeURIComponent(id)}/simulate`, {
      method: "POST",
    });
  },
};
