require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const net = require('net');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const MAX_LOGS = 1000;
const HTTP_PORT = 8980; // serves index.html and hosts WebSocket at /ws/
const TCP_PORT = 8981; // AQW bot TCP clients connect here

// Handshake configuration
const HANDSHAKE_TIMEOUT = 10000; // 10 seconds
const HANDSHAKE_SECRET = process.env.HANDSHAKE_SECRET || 'a19a4c53f65a808c627692f29fe68a0cdfd5c2f0845666f67527d9418c00fdc6';

// ------------------------- State -------------------------
let tcpClients = {};              // clientId -> net.Socket
let clientLogs = {};              // clientId -> [log strings]
let wsClients = new Set();        // connected browser sockets
let clientNames = {};             // clientId -> friendly name
let clientStatus = {};            // clientId -> { loaded, logged, scriptRunning, loadedScript }
let clientLastHeartbeat = {};     // clientId -> timestamp
let masterLog = [];               // in-memory master log (not persisted)
let pendingHandshakes = {};       // clientId -> { challenge, timestamp }
let clientStateCache = {};        // clientId -> cached state object for diffing
let clientUsernameStatus = {};  // clientId -> { hasUsername: boolean, requestSent: boolean, checker: intervalId }

// Utility: stable id per TCP connection
function getClientId(socket) {
  return `${socket.remoteAddress}:${socket.remotePort}`;
}

// Handshake utilities
function generateChallenge() {
  return crypto.randomBytes(32).toString('hex');
}

function computeHandshakeResponse(challenge, secret) {
  return crypto.createHmac('sha256', secret)
    .update(challenge)
    .digest('hex');
}

function isValidHandshakeResponse(challenge, response, secret) {
  const expectedResponse = computeHandshakeResponse(challenge, secret);
  return crypto.timingSafeEqual(
    Buffer.from(response, 'hex'),
    Buffer.from(expectedResponse, 'hex')
  );
}
// Deep compare function for state diffing
function deepCompare(obj1, obj2) {
  if (obj1 === obj2) return true;
  if (obj1 == null || obj2 == null) return false;
  if (typeof obj1 !== typeof obj2) return false;
  
  if (typeof obj1 === 'object') {
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    
    if (keys1.length !== keys2.length) return false;
    
    for (let key of keys1) {
      if (!keys2.includes(key)) return false;
      if (!deepCompare(obj1[key], obj2[key])) return false;
    }
    return true;
  }
  
  return obj1 === obj2;
}

// Get changed fields between two state objects  
function getChangedFields(oldState, newState) {
  const changes = {};
  const allKeys = new Set([...Object.keys(oldState || {}), ...Object.keys(newState || {})]);
  
  for (const key of allKeys) {
    if (!deepCompare(oldState?.[key], newState?.[key])) {
      changes[key] = newState[key];
    }
  }
  
  return Object.keys(changes).length > 0 ? changes : null;
}

// Process JSON message from client
function processJsonMessage(clientId, jsonData) {
  const { type, protocolVersion, timestamp, clientName, status, message } = jsonData;
  
  // Update client name if provided
  if (clientName && clientName !== clientNames[clientId]) {
    clientNames[clientId] = clientName;
    broadcastToBrowsers({ type: 'update_tab_name', id: clientId, name: clientName });
  }
  
  switch (type) {
    case 'status_update':
      handleStatusUpdate(clientId, status, timestamp);
      break;
      
    case 'heartbeat':
      clientLastHeartbeat[clientId] = Date.now();
      break;
      
    case 'username_response':
      const username = jsonData.username;
      handleUsernameResponse(clientId, username);
      break;

    case 'log':
      if (message) {
        addClientLog(clientId, message);
      }
      break;
      
    default:
      addClientLog(clientId, `[Unknown JSON message type]: ${type}`);
  }
}

// Handle status update with caching and diffing
function handleStatusUpdate(clientId, newStatus, timestamp) {
  if (!newStatus) {
    addClientLog(clientId, '[Status update - no status data]');
    return;
  }
  
  const oldStatus = clientStateCache[clientId] || {};
  const changes = getChangedFields(oldStatus, newStatus);
  
  if (!changes) {
    // No changes detected, don't broadcast
    addClientLog(clientId, '[Status update - no changes detected]');
    return;
  }
  
  // Update cache
  clientStateCache[clientId] = { ...newStatus };
  
  // Update internal status tracking for backward compatibility
  if (changes.loaded !== undefined) updateStatus(clientId, 'loaded', changes.loaded);
  if (changes.logged !== undefined) updateStatus(clientId, 'logged', changes.logged);
  if (changes.scriptRunning !== undefined) updateStatus(clientId, 'scriptRunning', changes.scriptRunning);
  if (changes.loadedScript !== undefined) updateStatus(clientId, 'loadedScript', changes.loadedScript);
  
  // Broadcast enhanced status update
  broadcastToBrowsers({
    type: 'status_update_json',
    id: clientId,
    status: newStatus,
    changes: changes,
    timestamp: timestamp || new Date().toISOString(),
    serverTime: new Date().toISOString()
  });
  
  addClientLog(clientId, `[Status updated - Changes: ${Object.keys(changes).join(', ')}]`);
}

// Convert legacy command to JSON format (for backward compatibility)
function convertLegacyToJson(clientId, message) {
  const timestamp = new Date().toISOString();
  const currentStatus = clientStateCache[clientId] || { loaded: false, logged: false, scriptRunning: false, loadedScript: '' };
  
  if (message.startsWith('$ClientName:')) {
    const clientName = message.substring('$ClientName:'.length).trim();
    return {
      type: 'status_update',
      protocolVersion: '1.0',
      timestamp,
      clientName,
      status: currentStatus
    };
  } else if (message.startsWith('$IsLoaded:')) {
    const loaded = message.split(':')[1].trim().toLowerCase() === 'true';
    return {
      type: 'status_update', 
      protocolVersion: '1.0',
      timestamp,
      status: { ...currentStatus, loaded }
    };
  } else if (message.startsWith('$IsLogged:')) {
    const logged = message.split(':')[1].trim().toLowerCase() === 'true';
    return {
      type: 'status_update',
      protocolVersion: '1.0', 
      timestamp,
      status: { ...currentStatus, logged }
    };
  } else if (message.startsWith('$IsScriptRunning:')) {
    const scriptRunning = message.split(':')[1].trim().toLowerCase() === 'true';
    return {
      type: 'status_update',
      protocolVersion: '1.0',
      timestamp,
      status: { ...currentStatus, scriptRunning }
    };
  } else if (message.startsWith('$LoadedScript:')) {
    const loadedScript = message.substring('$LoadedScript:'.length).trim();
    return {
      type: 'status_update',
      protocolVersion: '1.0',
      timestamp, 
      status: { ...currentStatus, loadedScript }
    };
  } else if (message === '$Heartbeat') {
    return {
      type: 'heartbeat',
      protocolVersion: '1.0',
      timestamp
    };
  } else {
    return {
      type: 'log',
      protocolVersion: '1.0',
      timestamp,
      message
    };
  }
}


// ------------------- Authentication -------------------------
const ENV_FILE = path.join(__dirname, '.env');

// Parse .env file dynamically
function parseEnvFile() {
  if (!fs.existsSync(ENV_FILE)) {
    return {};
  }
  
  const content = fs.readFileSync(ENV_FILE, 'utf8');
  const env = {};
  
  content.split('\n').forEach(line => {
    line = line.trim();
    if (line && !line.startsWith('#')) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        env[key] = valueParts.join('=');
      }
    }
  });
  
  return env;
}

// Dynamically load users from .env file
function loadUsers() {
  const env = parseEnvFile();
  const users = {};
  
  // Find all username/password hash pairs
  Object.keys(env).forEach(key => {
    if (key.endsWith('_USERNAME')) {
      const prefix = key.replace('_USERNAME', '');
      const passwordKey = `${prefix}_PASSWORD_HASH`;
      
      if (env[passwordKey]) {
        users[env[key]] = env[passwordKey];
      }
    }
  });
  
  // Fallback to hardcoded users if no users found (development only)
  if (Object.keys(users).length === 0) {
    console.warn('WARNING: No users found in .env file. Using hardcoded credentials.');
    users['admin'] = '$2b$12$YjgksSv2iJyckrok0TbAwu6zQcnreHBfmn2/6UDE13GYoiz1M8Hbm'; // password123
    users['user'] = '$2b$12$CAV5n30mnmN.zvW2Yv7/1e/YemAXybHTxEiZCXoxHb1m87OS4GUTO'; // botlogger
  }
  
  return users;
}

async function verifyPassword(plainPassword, hashedPassword) {
  return await bcrypt.compare(plainPassword, hashedPassword);
}

// Session configuration
const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'veinheim-bot-logger-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // set to true in production with HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
};

// ------------------- HTTP server (static UI + API) -------------------
const httpServer = http.createServer((req, res) => {
  // Handle API routes first
  if (req.url.startsWith('/api/')) {
    handleApiRequest(req, res);
    return;
  }

  // Parse URL to handle both paths and query parameters
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath;
  
  // If it's the root path or has query parameters, serve index.html
  if (url.pathname === '/' || url.search.includes('debug')) {
    filePath = path.join(__dirname, 'dist/index.html');
  } else {
    // Try to serve the requested file
    filePath = path.join(__dirname, 'dist', url.pathname.replace(/^\//, ''));
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // If file not found and it's not a static asset, serve index.html for SPA routing
      const isStaticAsset = /\.(js|css|json|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i.test(url.pathname);
      
      if (!isStaticAsset) {
        // Serve index.html for SPA routes like /debug, /login
        const indexPath = path.join(__dirname, 'dist/index.html');
        fs.readFile(indexPath, (indexErr, indexData) => {
          if (indexErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('Not Found');
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(indexData);
        });
        return;
      }
      
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }
    
    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === '.js'  ? 'application/javascript' :
      ext === '.css' ? 'text/css' :
      ext === '.json'? 'application/json' :
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      'text/html';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// Simple session store
const sessions = new Map();

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function getSessionFromCookie(req) {
  const cookies = req.headers.cookie;
  if (!cookies) return null;
  
  const sessionCookie = cookies
    .split(';')
    .find(c => c.trim().startsWith('sessionId='));
  
  if (!sessionCookie) return null;
  
  const sessionId = sessionCookie.split('=')[1];
  return sessions.get(sessionId);
}

async function handleApiRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const { username, password } = await parseBody(req);
      
      // Load users dynamically from .env file
      const users = loadUsers();
      console.log('Available users:', Object.keys(users)); // Debug log
      
      if (users[username] && await verifyPassword(password, users[username])) {
        const sessionId = generateSessionId();
        const userData = { username, isAuthenticated: true };
        
        sessions.set(sessionId, userData);
        
        res.setHeader('Set-Cookie', `sessionId=${sessionId}; HttpOnly; Path=/; Max-Age=86400`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(userData));
        
        console.log(`✅ User '${username}' logged in successfully`);
      } else {
        console.log(`❌ Login failed for username: '${username}'`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid credentials' }));
      }
    } else if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const session = getSessionFromCookie(req);
      if (session) {
        const cookies = req.headers.cookie;
        const sessionCookie = cookies
          .split(';')
          .find(c => c.trim().startsWith('sessionId='));
        
        if (sessionCookie) {
          const sessionId = sessionCookie.split('=')[1];
          sessions.delete(sessionId);
        }
      }
      
      res.setHeader('Set-Cookie', 'sessionId=; HttpOnly; Path=/; Max-Age=0');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } else if (url.pathname === '/api/auth/status' && req.method === 'GET') {
      const session = getSessionFromCookie(req);
      
      if (session) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not authenticated' }));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API endpoint not found' }));
    }
  } catch (error) {
    console.error('API error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`HTTP server (UI) listening on http://0.0.0.0:${HTTP_PORT}`);
});

// ---------------- WebSocket server (attached to HTTP) ----------------
const wss = new WebSocket.Server({ server: httpServer, path: '/ws/' });

wss.on('connection', (ws) => {
  wsClients.add(ws);

  // Send current master log to new browser
  masterLog.forEach(msg => ws.send(JSON.stringify({ type: 'master_log', message: msg })));

  // Send current clients + their status + their logs
  Object.keys(tcpClients).forEach(id => {
    ws.send(JSON.stringify({ type: 'client_connect', id, name: clientNames[id] || id }));

    const status = clientStatus[id] || {};
    ['loaded','logged','scriptRunning','loadedScript'].forEach(field => {
      const value = field === 'loadedScript' ? (status[field] || '') : !!status[field];
      ws.send(JSON.stringify({ type: 'update_status', id, field, value }));
    });

    (clientLogs[id] || []).forEach(msg =>
      ws.send(JSON.stringify({ type: 'log', id, message: msg }))
    );
  });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'send_to_client') {
      const socket = tcpClients[data.id];
      if (socket) {
        socket.write((data.message || '') + '\n');
        addClientLog(data.id, `[Server -> ${clientNames[data.id] || data.id}]: ${data.message}`);
      }
    } else if (data.type === 'request_username') {
      // Manual username request from frontend
      const clientId = data.id;
      if (tcpClients[clientId] && isClientAuthenticated(clientId)) {
        if (sendUsernameRequest(clientId)) {
          addMasterLog(`Manual username request sent to ${clientId}`, clientId);
        } else {
          addMasterLog(`Failed to send username request to ${clientId}`, clientId);
        }
      }

    } else if (data.type === 'clear_master_log') {
      clearMasterLog();
    }
  });

  ws.on('close', () => wsClients.delete(ws));
});

// ------------------------ Helpers ------------------------
function broadcastToBrowsers(obj) {
  const json = JSON.stringify(obj);
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  });
}

function addClientLog(id, msg) {
  if (!clientLogs[id]) clientLogs[id] = [];
  clientLogs[id].push(msg);
  if (clientLogs[id].length > MAX_LOGS) clientLogs[id].shift();

  broadcastToBrowsers({ type: 'log', id, message: msg });
  console.log(msg);
}

function addMasterLog(msg, clientId = null) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/Chicago' });
  if (clientId && clientNames[clientId]) {
    msg = msg.replace(clientId, clientNames[clientId]);
  }
  const logEntry = `[${timestamp}] ${msg}`;
  console.log('[MASTER]', logEntry);
  masterLog.push(logEntry);
  if (masterLog.length > MAX_LOGS) masterLog.shift();

  fs.appendFile('master.log', logEntry + '\n', () => {});
  broadcastToBrowsers({ type: 'master_log', message: logEntry });
}

function clearMasterLog() {
  masterLog = [];
  broadcastToBrowsers({ type: 'clear_master_log' });
}

function updateStatus(id, field, value) {
  if (!clientStatus[id]) clientStatus[id] = { loaded: false, logged: false, scriptRunning: false, loadedScript: '' };
  clientStatus[id][field] = value;
  broadcastToBrowsers({ type: 'update_status', id, field, value });
}

function cleanupClient(id) {
  delete tcpClients[id];
  delete clientLogs[id];
  delete clientNames[id];
  delete clientStatus[id];
  delete clientLastHeartbeat[id];
  delete pendingHandshakes[id];
  delete clientStateCache[id]; // Clear cached state
  
  // Stop username checker and cleanup
  stopUsernameChecker(id);
  delete clientUsernameStatus[id];
}

function startHandshake(socket, clientId) {
  const challenge = generateChallenge();
  pendingHandshakes[clientId] = {
    challenge,
    timestamp: Date.now(),
    authenticated: false
  };

  // Send handshake challenge
  socket.write(`$HandshakeChallenge:${challenge}\n`);
  addMasterLog(`Handshake challenge sent to ${clientId}`, clientId);

  // Set timeout for handshake
  setTimeout(() => {
    if (pendingHandshakes[clientId] && !pendingHandshakes[clientId].authenticated) {
      addMasterLog(`Handshake timeout for ${clientId}`, clientId);
      socket.destroy();
      cleanupClient(clientId);
      broadcastToBrowsers({ type: 'client_disconnect', id: clientId });
    }
  }, HANDSHAKE_TIMEOUT);
}

function processHandshakeResponse(socket, clientId, response) {
  const handshake = pendingHandshakes[clientId];
  if (!handshake) {
    addMasterLog(`Unexpected handshake response from ${clientId}`, clientId);
    socket.destroy();
    return false;
  }

  if (Date.now() - handshake.timestamp > HANDSHAKE_TIMEOUT) {
    addMasterLog(`Handshake response too late from ${clientId}`, clientId);
    socket.destroy();
    cleanupClient(clientId);
    broadcastToBrowsers({ type: 'client_disconnect', id: clientId });
    return false;
  }

  if (isValidHandshakeResponse(handshake.challenge, response, HANDSHAKE_SECRET)) {
    handshake.authenticated = true;
    socket.write(`$HandshakeSuccess\n`);
    addMasterLog(`Handshake successful for ${clientId}`, clientId);
    
    // Start username monitoring
    startUsernameChecker(clientId);
    return true;
  } else {
    addMasterLog(`Handshake failed for ${clientId} - invalid response`, clientId);
    socket.destroy();
    cleanupClient(clientId);
    broadcastToBrowsers({ type: 'client_disconnect', id: clientId });
    return false;
  }
}

function isClientAuthenticated(clientId) {
  const handshake = pendingHandshakes[clientId];
  return handshake && handshake.authenticated;
}

// ---------------- TCP server (AQW bot clients) ----------------
const tcpServer = net.createServer((socket) => {
  const clientId = getClientId(socket);
  tcpClients[clientId] = socket;
  clientNames[clientId] = clientId;
  clientStatus[clientId] = { loaded: false, logged: false, scriptRunning: false, loadedScript: '' };
  clientLastHeartbeat[clientId] = Date.now();

  addClientLog(clientId, `[Client ${clientNames[clientId]} connected - awaiting handshake]`);
  addMasterLog(`Client connected: ${clientId} - initiating handshake`, clientId);
  broadcastToBrowsers({ type: 'client_connect', id: clientId, name: clientNames[clientId] });

  // Start handshake process
  startHandshake(socket, clientId);

  socket.on('data', (buf) => {
    const lines = buf.toString().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    lines.forEach(msg => {
      // Handle handshake response first
      if (msg.startsWith('$HandshakeResponse:')) {
        const response = msg.substring('$HandshakeResponse:'.length).trim();
        processHandshakeResponse(socket, clientId, response);
        return;
      }

      // Check if client is authenticated before processing other messages
      if (!isClientAuthenticated(clientId)) {
        addClientLog(clientId, `[Unauthenticated message rejected]: ${msg}`);
        return;
      }

      // Try to parse as JSON first
      try {
        const jsonData = JSON.parse(msg);
        processJsonMessage(clientId, jsonData);
      } catch (e) {
        // Fallback to legacy text parsing if JSON parsing fails
        const legacyJson = convertLegacyToJson(clientId, msg);
        processJsonMessage(clientId, legacyJson);
      }
    });
  });

  socket.on('close', () => {
    addClientLog(clientId, `[Client ${clientNames[clientId]} disconnected]`);
    addMasterLog(`Client disconnected: ${clientId}`, clientId);
    broadcastToBrowsers({ type: 'client_disconnect', id: clientId });
    cleanupClient(clientId);
  });

  socket.on('error', (err) => {
    addClientLog(clientId, `[Client ${clientNames[clientId]} error] ${err}`);
  });
});

// Heartbeat monitor (30s timeout) - only for authenticated clients
setInterval(() => {
  const now = Date.now();
  Object.keys(tcpClients).forEach(id => {
    if (isClientAuthenticated(id) && now - (clientLastHeartbeat[id] || 0) > 30000) {
      addMasterLog(`Client timeout: ${id}`, id);
      try { tcpClients[id].destroy(); } catch {}
      cleanupClient(id);
      broadcastToBrowsers({ type: 'client_disconnect', id });
    }
  });
}, 5000);

// Clean up expired handshakes
setInterval(() => {
  const now = Date.now();
  Object.keys(pendingHandshakes).forEach(id => {
    const handshake = pendingHandshakes[id];
    if (!handshake.authenticated && now - handshake.timestamp > HANDSHAKE_TIMEOUT) {
      if (tcpClients[id]) {
        tcpClients[id].destroy();
      }
      cleanupClient(id);
      broadcastToBrowsers({ type: 'client_disconnect', id });
    }
  });
}, 5000);

// ---------------- Start listeners ----------------
tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
  console.log(`TCP server listening on 0.0.0.0:${TCP_PORT}`);
  console.log(`Handshake enabled with ${HANDSHAKE_TIMEOUT}ms timeout`);
});
// Username request functions
function sendUsernameRequest(clientId) {
  const socket = tcpClients[clientId];
  if (!socket || !isClientAuthenticated(clientId)) {
    return false;
  }

  try {
    const request = {
      type: 'username_request',
      protocolVersion: '1.0',
      timestamp: new Date().toISOString()
    };
    
    socket.write(JSON.stringify(request) + '\n');
    addClientLog(clientId, '[Server requested username from client]');
    return true;
  } catch (error) {
    addClientLog(clientId, `[Username request failed]: ${error.message}`);
    return false;
  }
}

function startUsernameChecker(clientId) {
  // Don't start if already checking
  if (clientUsernameStatus[clientId]?.checker) {
    return;
  }

  // Initialize status
  clientUsernameStatus[clientId] = {
    hasUsername: false,
    requestSent: false,
    checker: null
  };

  // Start checking every second
  clientUsernameStatus[clientId].checker = setInterval(() => {
    const status = clientUsernameStatus[clientId];
    
    if (status.hasUsername) {
      // Username received, stop checking
      clearInterval(status.checker);
      status.checker = null;
      addClientLog(clientId, '[Username checker stopped - username received]');
      return;
    }

    if (!status.requestSent) {
      // Send username request
      if (sendUsernameRequest(clientId)) {
        status.requestSent = true;
        addClientLog(clientId, '[Username request sent to client]');
      }
    }
  }, 1000); // Check every second

  addClientLog(clientId, '[Started username monitoring]');
}

function stopUsernameChecker(clientId) {
  const status = clientUsernameStatus[clientId];
  if (status?.checker) {
    clearInterval(status.checker);
    status.checker = null;
    addClientLog(clientId, '[Username checker stopped]');
  }
}

function handleUsernameResponse(clientId, username) {
  if (!username) {
    addClientLog(clientId, '[Username response received but empty]');
    return;
  }

  // Update client name
  const oldName = clientNames[clientId];
  clientNames[clientId] = username;
  
  // Mark as having username
  if (clientUsernameStatus[clientId]) {
    clientUsernameStatus[clientId].hasUsername = true;
  }

  // Stop the checker (will be handled in next interval)
  // No need to manually stop here as the interval will self-terminate

  addClientLog(clientId, `[Username received]: ${username}`);
  
  // Broadcast tab name update if it changed
  if (oldName !== username) {
    broadcastToBrowsers({ type: 'update_tab_name', id: clientId, name: username });
    addClientLog(clientId, `[Tab name updated]: ${oldName} -> ${username}`);
  }
}

