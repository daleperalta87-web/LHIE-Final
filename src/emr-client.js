'use strict';

function createEmrClient({ baseUrl, apiKey, fetchImpl = globalThis.fetch }) {
  if (!baseUrl) throw new Error('baseUrl is required');
  if (!apiKey) throw new Error('apiKey is required');
  if (typeof fetchImpl !== 'function') throw new Error('A Fetch-compatible implementation is required');

  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('baseUrl must use HTTP or HTTPS');
  const root = base.toString().replace(/\/+$/, '');

  async function request(path, { method = 'GET', body } = {}) {
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: {
        accept: 'application/json, application/fhir+json',
        'x-api-key': apiKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    if (!response.ok) {
      const error = new Error(payload?.error || `SHR API returned HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  return Object.freeze({
    checkHealth: () => request('/api/health'),
    searchPatients: (query) => request(`/api/patients/search?q=${encodeURIComponent(query)}`),
    getPatientRecord: (philsysId) => request(`/api/patients/${encodeURIComponent(philsysId)}/record`),
    getInbox: () => request('/api/inbox'),
    getOutbox: () => request('/api/outbox'),
    sendReferral: (referral) => request('/api/referrals', { method: 'POST', body: referral }),
    receiveReferral: (referralId) => request(`/api/referrals/${encodeURIComponent(referralId)}/receive`, { method: 'POST', body: {} }),
    sendBackReferral: (referralId, referral) => request(`/api/referrals/${encodeURIComponent(referralId)}/back-referral`, { method: 'POST', body: referral }),
  });
}

module.exports = { createEmrClient };
