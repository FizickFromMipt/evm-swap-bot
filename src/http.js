const https = require('https');
const http = require('http');
const axios = require('axios');

// Shared keep-alive agents — reuse TCP connections across all requests
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 10,
  maxFreeSockets: 5,
});

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 10,
  maxFreeSockets: 5,
});

// Shared axios instance with keep-alive for all external API calls (DexScreener, etc.)
const client = axios.create({
  httpAgent,
  httpsAgent,
  headers: {
    Connection: 'keep-alive',
  },
});

module.exports = { client, httpsAgent, httpAgent };
