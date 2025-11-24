const TelegramBot = require('node-telegram-bot-api');
const mqtt = require('mqtt');
const fs = require('fs');
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

// Load config
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const TOKEN = config.telegram.token;
const ADMIN_ID = config.telegram.adminId;
const DEVICE_PASSWORD = config.passwords.device;
const USER_PASSWORD = config.passwords.user;

// Load data
let devices = JSON.parse(fs.readFileSync('devices.json', 'utf8'));
let users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
let pending = JSON.parse(fs.readFileSync('pending.json', 'utf8'));

// Constants
const MAX_DEVICES = 25;
const WARNING_THRESHOLD = 20;

// Pending actions (for confirmations)
const pendingActions = new Map();

// Track synced devices
const syncedDevices = new Set();

// Track sync requests to skip notifications
const syncInProgress = new Set();

// Track user control to skip notifications
const userControlInProgress = new Set();

// Offline detection timeout (60 seconds)
const OFFLINE_TIMEOUT = 60000;

// Save functions
function saveDevices() {
  fs.writeFileSync('devices.json', JSON.stringify(devices, null, 2));
}

function saveUsers() {
  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
}

function savePending() {
  fs.writeFileSync('pending.json', JSON.stringify(pending, null, 2));
}

// Init bot
const bot = new TelegramBot(TOKEN, { 
  polling: {
    interval: 300,
    autoStart: true
  }
});

// MQTT client
const mqttClient = mqtt.connect(config.mqtt.broker);

mqttClient.on('connect', () => {
  console.log('✅ MQTT Connected');
  mqttClient.subscribe('device/+/status');
  mqttClient.subscribe('device/+/switch1/state');
  mqttClient.subscribe('device/+/switch2/state');
  mqttClient.subscribe('device/+/switch3/state');
  mqttClient.subscribe('device/+/switch4/state');
  mqttClient.subscribe('device/+/remember/state');
  mqttClient.subscribe('device/+/ip');
  console.log('✅ Subscribed to device topics');
});

mqttClient.on('message', (topic, message) => {
  const msg = message.toString();
  console.log(`📩 MQTT RX: ${topic} = ${msg}`);
  
  // Parse topic: device/{ID}/status
  const parts = topic.split('/');
  if (parts.length < 3) return;
  
  const deviceId = parts[1];
  const subtopic = parts[2];
  
  console.log(`DEBUG: deviceId=${deviceId}, subtopic=${subtopic}, parts.length=${parts.length}`);
  
  // Device status (auto discovery and LWT)
  if (subtopic === 'status') {
    // Handle offline from LWT
    if (msg === 'offline') {
      const device = devices.find(d => d.id === deviceId);
      if (device) {
        device.online = false;
        device.lastSeen = Date.now();
        console.log(`🔴 ${deviceId} offline (LWT)`);
      }
      return;
    }
    
    // Handle online
    if (msg === 'online') {
      // Check if device exists
      const exists = devices.find(d => d.id === deviceId);
      if (!exists) {
      // Check if already pending
      const isPending = pending.devices.find(d => d.id === deviceId);
      if (!isPending) {
        pending.devices.push({
          id: deviceId,
          name: deviceId.replace(/_/g, ' '),
          timestamp: Date.now()
        });
        savePending();
        
        // Notify all users
        users.forEach(userId => {
          bot.sendMessage(userId, 
            `🆕 *New Device Detected!*\n\n` +
            `ID: \`${deviceId.replace(/_/g, '\\_')}\`\n` +
            `Name: ${deviceId.replace(/_/g, ' ')}\n\n` +
            `To approve, use:\n` +
            `/approve ${deviceId} PASSWORD`,
            { parse_mode: 'Markdown' }
          );
        });
        
        console.log(`🆕 New device detected: ${deviceId}`);
      }
    } else {
      // Update online status and lastSeen
      const wasOffline = !exists.online;
      exists.online = true;
      exists.lastSeen = Date.now();
      
      // Only sync if device was offline (first connect or reconnect)
      if (wasOffline || !syncedDevices.has(deviceId)) {
        console.log(`🟢 ${deviceId} online`);
        syncedDevices.add(deviceId);
        
        // Request state sync after 500ms
        setTimeout(() => {
          mqttClient.publish(`device/${deviceId}/command/sync`, '1', { qos: 0 });
          console.log(`🔄 Sync request sent to ${deviceId}`);
        }, 500);
      }
    }
    }
  }
  
  // Switch state update
  if (subtopic.startsWith('switch') && parts.length === 4 && parts[3] === 'state') {
    const device = devices.find(d => d.id === deviceId);
    if (device) {
      const swNum = parseInt(subtopic.match(/\d+/)[0]) - 1;
      if (swNum >= 0 && swNum < 4) {
        const oldState = device.switches[swNum];
        device.switches[swNum] = (msg === '1');
        saveDevices();
        console.log(`🔄 ${deviceId} SW${swNum+1}: ${msg === '1' ? 'ON' : 'OFF'}`);
        
        // Only send notification if NOT syncing and NOT user control
        const controlKey = `${deviceId}_${swNum+1}`;
        if (!syncInProgress.has(deviceId) && !userControlInProgress.has(controlKey)) {
          const emoji = msg === '1' ? '🟢' : '⚪';
          const status = msg === '1' ? 'ON' : 'OFF';
          const notifText = `${emoji} *${device.name}*\nSW${swNum+1}: ${status}`;
          
          console.log(`📢 Sending notification to ${users.length} users`);
          users.forEach(userId => {
            bot.sendMessage(userId, notifText, { parse_mode: 'Markdown' })
              .then(() => console.log(`✅ Notif sent to ${userId}`))
              .catch(err => console.error(`❌ Notif error to ${userId}:`, err.message));
          });
        } else {
          console.log(`⏭️ Skip notification (syncing or user control)`);
        }
        
        // Broadcast to web clients
        io.emit('deviceUpdate', { 
          deviceId, 
          relay: swNum + 1, 
          state: msg === '1' 
        });
      }
    }
  }
  
  // Remember state update
  if (subtopic === 'remember/state') {
    const device = devices.find(d => d.id === deviceId);
    if (device) {
      device.rememberState = (msg === '1');
      saveDevices();
    }
  }
  
  // IP address update
  if (subtopic === 'ip') {
    const device = devices.find(d => d.id === deviceId);
    if (device) {
      device.ip = msg;
      saveDevices();
      console.log(`📍 ${deviceId} IP: ${msg}`);
    }
  }
});

// MQTT control
function controlDevice(deviceId, relay, state, skipNotif = false) {
  const topic = `device/${deviceId}/command/switch${relay}`;
  mqttClient.publish(topic, state ? '1' : '0', { qos: 0 });
  console.log(`MQTT: ${topic} = ${state ? '1' : '0'}`);
  
  // Mark to skip notification if requested (Telegram only)
  if (skipNotif) {
    const key = `${deviceId}_${relay}`;
    userControlInProgress.add(key);
    setTimeout(() => userControlInProgress.delete(key), 2000);
  }
}

// Auth check
function isAuth(userId) {
  return users.includes(userId.toString());
}

function isAdmin(userId) {
  return userId.toString() === ADMIN_ID;
}

// Set bot commands (menu button)
bot.setMyCommands([
  { command: 'control', description: '🎛️ Control devices' },
  { command: 'status', description: '📊 Device status' },
  { command: 'devices', description: '📱 List devices' },
  { command: 'webui', description: '🌐 Web UI access' },
  { command: 'pending', description: '⏳ Pending approvals' },
  { command: 'users', description: '👥 List users' },
  { command: 'register', description: '🔐 Register as user' },
  { command: 'confirm', description: '✅ Confirm action' },
  { command: 'cancel', description: '❌ Cancel action' },
  { command: 'help', description: '❓ Help' }
]);

// Generate keyboards
function getDeviceKeyboard(page = 0) {
  const perPage = 10;
  const start = page * perPage;
  const end = start + perPage;
  const pageDevices = devices.slice(start, end);
  
  if (devices.length === 0) {
    return { inline_keyboard: [[{ text: '❌ No devices', callback_data: 'none' }]] };
  }
  
  const buttons = pageDevices.map((dev, idx) => {
    const statusEmoji = dev.online ? '🟢' : '🔴';
    return [{
      text: `${statusEmoji} ${dev.name}`,
      callback_data: `d${start + idx}`
    }];
  });
  
  // Pagination
  const navButtons = [];
  if (page > 0) {
    navButtons.push({ text: '⬅️ Prev', callback_data: `page${page - 1}` });
  }
  if (end < devices.length) {
    navButtons.push({ text: 'Next ➡️', callback_data: `page${page + 1}` });
  }
  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }
  
  buttons.push([
    { text: '🌐 Bridge Web', url: `http://${getLocalIP()}:3000/control-web-v2.html` },
    { text: '📱 Device Web', callback_data: 'webui' }
  ]);
  
  buttons.push([
    { text: '🔴 OFF All', callback_data: 'aoff' },
    { text: '🟢 ON All', callback_data: 'aon' }
  ]);
  
  return { inline_keyboard: buttons };
}

function getSwitchKeyboard(idx) {
  const dev = devices[idx];
  const buttons = [];
  
  for (let i = 0; i < 4; i += 2) {
    const row = [];
    const emoji1 = dev.switches[i] ? '🟢' : '⚪';
    row.push({ text: `${emoji1} SW${i+1}`, callback_data: `t${idx}${i+1}` });
    
    if (i+1 < 4) {
      const emoji2 = dev.switches[i+1] ? '🟢' : '⚪';
      row.push({ text: `${emoji2} SW${i+2}`, callback_data: `t${idx}${i+2}` });
    }
    buttons.push(row);
  }
  
  buttons.push([
    { text: '🟢 ON', callback_data: `on${idx}` },
    { text: '🔴 OFF', callback_data: `off${idx}` }
  ]);
  buttons.push([
    { text: '🔄 Refresh', callback_data: `r${idx}` },
    { text: '⬅️ Back', callback_data: 'bk' }
  ]);
  
  return { inline_keyboard: buttons };
}

// Commands
bot.onText(/\/start|\/help/, (msg) => {
  const userId = msg.from.id.toString();
  
  if (!isAuth(userId)) {
    bot.sendMessage(msg.chat.id, 
      '🔒 *Access Denied*\n\n' +
      'You are not authorized. To register:\n' +
      `/register PASSWORD`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  const text = '🏠 *Smart Home Control*\n\n' +
    '📱 *Commands:*\n' +
    '/control \- Control devices\n' +
    '/status \- Device status\n' +
    '/devices \- Manage devices\n' +
    '/pending \- Pending approvals\n' +
    '/users \- List users\n\n' +
    '✅ *Actions:*\n' +
    '/confirm \- Confirm action\n' +
    '/cancel \- Cancel action\n' +
    '/skip \- Skip custom name\n\n' +
    '📊 *Limits:*\n' +
    `Max devices: ${MAX_DEVICES}\n` +
    `Warning at: ${WARNING_THRESHOLD}`;
  
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/control/, (msg) => {
  if (!isAuth(msg.from.id.toString())) {
    bot.sendMessage(msg.chat.id, '🔒 Access denied');
    return;
  }
  
  bot.sendMessage(msg.chat.id, '💡 *Control*\n\nSelect device:', {
    parse_mode: 'Markdown',
    reply_markup: getDeviceKeyboard()
  });
});

bot.onText(/\/status/, (msg) => {
  if (!isAuth(msg.from.id.toString())) {
    bot.sendMessage(msg.chat.id, '🔒 Access denied');
    return;
  }
  
  if (devices.length === 0) {
    bot.sendMessage(msg.chat.id, '❌ No devices registered');
    return;
  }
  
  let text = '📊 *Status*\n\n';
  devices.forEach(dev => {
    const status = dev.online ? '🟢' : '🔴';
    text += `${status} *${dev.name}*\n`;
    dev.switches.forEach((state, i) => {
      const emoji = state ? '🟢' : '⚪';
      text += `  ${emoji} SW${i+1}\n`;
    });
    text += '\n';
  });
  
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/devices/, (msg) => {
  if (!isAuth(msg.from.id.toString())) {
    bot.sendMessage(msg.chat.id, '🔒 Access denied');
    return;
  }
  
  if (devices.length === 0) {
    bot.sendMessage(msg.chat.id, '❌ No devices registered');
    return;
  }
  
  let text = `📱 *Devices* (${devices.length}/${MAX_DEVICES})\n\n`;
  
  // Warning if approaching limit
  if (devices.length >= WARNING_THRESHOLD) {
    const remaining = MAX_DEVICES - devices.length;
    text += `⚠️ *Warning:* ${remaining} slots remaining\n`;
    if (devices.length >= MAX_DEVICES) {
      text += `❌ *Device limit reached!*\n`;
      text += `Remove devices to add new ones.\n`;
    }
    text += `\n`;
  }
  
  const buttons = [];
  
  const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  
  devices.forEach((dev, i) => {
    const status = dev.online ? '🟢' : '🔴';
    const remember = dev.rememberState ? '💾' : '❌';
    const escapedId = dev.id.replace(/_/g, '\\_');
    const escapedName = dev.name.replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&');
    const numEmoji = numberEmojis[i] || `${i+1}️⃣`;
    
    text += `${i+1}. ${status} *${escapedName}*\n`;
    text += `   ID: \`${escapedId}\`\n`;
    text += `   Remember: ${remember}\n\n`;
    
    // Buttons per device with numbering
    buttons.push([
      { text: `${numEmoji} Rename`, callback_data: `rn_${dev.id}` },
      { text: `${numEmoji} ${dev.rememberState ? '💾 ON' : '❌ OFF'}`, callback_data: `mem_${dev.id}` },
      { text: `${numEmoji} Remove`, callback_data: `rm_${dev.id}` }
    ]);
  });
  
  bot.sendMessage(msg.chat.id, text, { 
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.onText(/\/pending/, (msg) => {
  if (!isAuth(msg.from.id.toString())) {
    bot.sendMessage(msg.chat.id, '🔒 Access denied');
    return;
  }
  
  if (pending.devices.length === 0 && pending.users.length === 0) {
    bot.sendMessage(msg.chat.id, '✅ No pending approvals');
    return;
  }
  
  let text = '⏳ *Pending Approvals*\n\n';
  const buttons = [];
  
  if (pending.devices.length > 0) {
    text += `📱 *Devices:* ${pending.devices.length}\n\n`;
    
    // Check if limit reached
    if (devices.length >= MAX_DEVICES) {
      text += `❌ *Cannot approve!* Device limit (${MAX_DEVICES}) reached.\n`;
      text += `Remove devices first using /devices\n\n`;
    } else {
      const remaining = MAX_DEVICES - devices.length;
      text += `Slots available: ${remaining}/${MAX_DEVICES}\n\n`;
      
      pending.devices.forEach((dev, i) => {
        const escapedId = dev.id.replace(/_/g, '\\_');
        text += `${i+1}. ${dev.name}\n`;
        text += `   ID: \`${escapedId}\`\n\n`;
        
        // Approve button
        buttons.push([{ text: `✅ Approve: ${dev.name}`, callback_data: `appr${i}` }]);
      });
    }
  }
  
  if (pending.users.length > 0) {
    text += '👥 *Users:*\n\n';
    pending.users.forEach((user, i) => {
      text += `${i+1}. ${user.name || 'Unknown'}\n`;
      text += `   ID: \`${user.id}\`\n\n`;
      
      // Approve button
      buttons.push([{ text: `✅ Approve: ${user.name}`, callback_data: `appu${i}` }]);
    });
  }
  
  bot.sendMessage(msg.chat.id, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.onText(/\/webui/, (msg) => {
  if (!isAuth(msg.from.id.toString())) {
    bot.sendMessage(msg.chat.id, '🔒 Access denied');
    return;
  }
  
  const localIP = getLocalIP();
  let text = '🌐 *Web UI Access*\n\n';
  text += '*Bridge Web UI:*\n';
  text += `http://${localIP}:3000/control-web-v2.html\n\n`;
  
  const buttons = [[
    { text: '🌐 Open Bridge Web', url: `http://${localIP}:3000/control-web-v2.html` }
  ]];
  
  if (devices.length > 0) {
    text += '*Device Web UI:*\n';
    text += '⚠️ Requires same WiFi network\n\n';
    
    devices.forEach((dev, i) => {
      const status = dev.online ? '🟢' : '🔴';
      const ip = dev.ip || 'unknown';
      text += `${i+1}. ${status} ${dev.name}\n`;
      text += `   IP: \`${ip}\`\n\n`;
      
      buttons.push([{
        text: `📱 ${dev.name}`,
        callback_data: `web_${dev.id}`
      }]);
    });
  }
  
  bot.sendMessage(msg.chat.id, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.onText(/\/users/, (msg) => {
  if (!isAuth(msg.from.id.toString())) {
    bot.sendMessage(msg.chat.id, '🔒 Access denied');
    return;
  }
  
  let text = `👥 *Users* (${users.length})\n\n`;
  users.forEach((userId, i) => {
    const isAdm = userId === ADMIN_ID;
    text += `${i+1}. ${userId} ${isAdm ? '👑' : ''}\n`;
  });
  
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/register (.+)/, (msg, match) => {
  const userId = msg.from.id.toString();
  const password = match[1].trim();
  
  if (isAuth(userId)) {
    bot.sendMessage(msg.chat.id, '✅ You are already registered');
    return;
  }
  
  if (password !== USER_PASSWORD) {
    bot.sendMessage(msg.chat.id, '❌ Wrong password');
    return;
  }
  
  // Add to pending
  const exists = pending.users.find(u => u.id === userId);
  if (exists) {
    bot.sendMessage(msg.chat.id, '⏳ Your registration is pending approval');
    return;
  }
  
  pending.users.push({
    id: userId,
    name: msg.from.first_name || msg.from.username || 'Unknown',
    timestamp: Date.now()
  });
  savePending();
  
  bot.sendMessage(msg.chat.id, '✅ Registration submitted! Waiting for approval...');
  
  // Notify all users
  users.forEach(uid => {
    bot.sendMessage(uid, 
      `🆕 *New User Registration!*\n\n` +
      `Name: ${msg.from.first_name || 'Unknown'}\n` +
      `ID: \`${userId}\`\n\n` +
      `To approve, use:\n` +
      `/approveuser ${userId} PASSWORD`,
      { parse_mode: 'Markdown' }
    );
  });
});

bot.onText(/\/confirm/, (msg) => {
  const userId = msg.from.id.toString();
  const action = pendingActions.get(userId);
  
  if (!action) {
    bot.sendMessage(msg.chat.id, '❌ No pending action to confirm');
    return;
  }
  
  if (action.type === 'remove') {
    const deviceIndex = devices.findIndex(d => d.id === action.deviceId);
    if (deviceIndex !== -1) {
      const device = devices[deviceIndex];
      devices.splice(deviceIndex, 1);
      saveDevices();
      bot.sendMessage(msg.chat.id, `✅ Device removed: ${device.name}`);
      console.log(`🗑️ Device removed: ${device.id}`);
    } else {
      bot.sendMessage(msg.chat.id, '❌ Device not found');
    }
  }
  
  pendingActions.delete(userId);
});

bot.onText(/\/cancel/, (msg) => {
  const userId = msg.from.id.toString();
  const action = pendingActions.get(userId);
  
  if (!action) {
    bot.sendMessage(msg.chat.id, '❌ No pending action to cancel');
    return;
  }
  
  bot.sendMessage(msg.chat.id, '✅ Action cancelled');
  pendingActions.delete(userId);
});

bot.onText(/\/skip/, (msg) => {
  const userId = msg.from.id.toString();
  const action = pendingActions.get(userId);
  
  if (!action || action.type !== 'approve_device') {
    bot.sendMessage(msg.chat.id, '❌ No pending approval');
    return;
  }
  
  // Approve with default name
  devices.push({
    id: action.deviceId,
    name: action.defaultName,
    online: false,
    switches: [false, false, false, false],
    rememberState: false
  });
  saveDevices();
  
  // Remove from pending
  pending.devices = pending.devices.filter(d => d.id !== action.deviceId);
  savePending();
  
  bot.sendMessage(msg.chat.id, `✅ Device approved: ${action.defaultName}`);
  console.log(`✅ Device approved: ${action.deviceId}`);
  
  pendingActions.delete(userId);
});

// Handle text messages for rename/approve
bot.on('message', (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!isAuth(msg.from.id.toString())) return;
  
  const userId = msg.from.id.toString();
  const action = pendingActions.get(userId);
  
  if (!action) return;
  
  // Handle approve device with custom name
  if (action.type === 'approve_device') {
    const customName = msg.text.trim();
    
    if (customName.length === 0) {
      bot.sendMessage(msg.chat.id, '❌ Name cannot be empty. Try again or /skip');
      return;
    }
    
    if (customName.length > 50) {
      bot.sendMessage(msg.chat.id, '❌ Name too long (max 50 chars). Try again.');
      return;
    }
    
    // Check limit again
    if (devices.length >= MAX_DEVICES) {
      bot.sendMessage(msg.chat.id, `❌ Device limit reached (${MAX_DEVICES})`);
      pendingActions.delete(userId);
      return;
    }
    
    // Add device
    devices.push({
      id: action.deviceId,
      name: customName,
      online: false,
      switches: [false, false, false, false],
      rememberState: false
    });
    saveDevices();
    
    // Remove from pending
    pending.devices = pending.devices.filter(d => d.id !== action.deviceId);
    savePending();
    
    bot.sendMessage(msg.chat.id, `✅ Device approved: ${customName}`);
    console.log(`✅ Device approved: ${action.deviceId} as "${customName}"`);
    
    pendingActions.delete(userId);
  }
  
  // Handle rename device
  else if (action.type === 'rename') {
    const newName = msg.text.trim();
    
    if (newName.length === 0) {
      bot.sendMessage(msg.chat.id, '❌ Name cannot be empty. Try again or /cancel');
      return;
    }
    
    if (newName.length > 50) {
      bot.sendMessage(msg.chat.id, '❌ Name too long (max 50 chars). Try again.');
      return;
    }
    
    const device = devices.find(d => d.id === action.deviceId);
    if (device) {
      const oldName = device.name;
      device.name = newName;
      saveDevices();
      
      bot.sendMessage(msg.chat.id, 
        `✅ *Renamed*\n\n` +
        `Old: ${oldName.replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&')}\n` +
        `New: ${newName.replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&')}`,
        { parse_mode: 'Markdown' }
      );
      console.log(`✏️ Device renamed: ${device.id} "${oldName}" → "${newName}"`);
    } else {
      bot.sendMessage(msg.chat.id, '❌ Device not found');
    }
    
    pendingActions.delete(userId);
  }
});

bot.onText(/\/approveuser ([^\s]+) (.+)/, (msg, match) => {
  if (!isAuth(msg.from.id.toString())) {
    bot.sendMessage(msg.chat.id, '🔒 Access denied');
    return;
  }
  
  const userId = match[1];
  const password = match[2].trim();
  
  if (password !== USER_PASSWORD) {
    bot.sendMessage(msg.chat.id, '❌ Wrong password');
    return;
  }
  
  const pendingUser = pending.users.find(u => u.id === userId);
  if (!pendingUser) {
    bot.sendMessage(msg.chat.id, '❌ User not found in pending list');
    return;
  }
  
  // Add to users
  users.push(userId);
  saveUsers();
  
  // Remove from pending
  pending.users = pending.users.filter(u => u.id !== userId);
  savePending();
  
  bot.sendMessage(msg.chat.id, `✅ User approved: ${pendingUser.name}`);
  bot.sendMessage(userId, '✅ Your registration has been approved! Use /help to get started.');
  console.log(`✅ User approved: ${userId}`);
});

bot.onText(/\/remember (.+)/, (msg, match) => {
  if (!isAuth(msg.from.id.toString())) {
    bot.sendMessage(msg.chat.id, '🔒 Access denied');
    return;
  }
  
  const deviceId = match[1].trim();
  const device = devices.find(d => d.id === deviceId);
  
  if (!device) {
    bot.sendMessage(msg.chat.id, '❌ Device not found');
    return;
  }
  
  // Toggle remember state
  device.rememberState = !device.rememberState;
  saveDevices();
  
  // Send MQTT command to device
  const topic = `device/${deviceId}/command/remember`;
  mqttClient.publish(topic, device.rememberState ? '1' : '0', { qos: 0 });
  
  const emoji = device.rememberState ? '💾' : '❌';
  const escapedId = deviceId.replace(/_/g, '\\_');
  bot.sendMessage(msg.chat.id, 
    `${emoji} *Remember State ${device.rememberState ? 'ON' : 'OFF'}*\n\n` +
    `Device: ${device.name}\n` +
    `ID: \`${escapedId}\`\n\n` +
    (device.rememberState ? 
      '✅ Device will remember relay states after restart' : 
      '❌ Device will reset to OFF after restart'),
    { parse_mode: 'Markdown' }
  );
  
  console.log(`💾 Remember ${device.rememberState ? 'ON' : 'OFF'}: ${deviceId}`);
});

// Callback handler
bot.on('callback_query', async (query) => {
  if (!isAuth(query.from.id.toString())) {
    bot.answerCallbackQuery(query.id, { text: '🔒 Access denied' });
    return;
  }
  
  const data = query.data;
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  
  console.log(`🔔 CALLBACK: data="${data}"`);
  
  if (data === 'none') {
    bot.answerCallbackQuery(query.id);
    return;
  }
  
  // Select device
  if (data.startsWith('d')) {
    const idx = parseInt(data.substring(1));
    const dev = devices[idx];
    
    if (!dev) {
      bot.answerCallbackQuery(query.id, { text: '❌ Device not found' });
      return;
    }
    
    // Check if device is offline
    if (!dev.online) {
      bot.answerCallbackQuery(query.id, { text: '❌ Device offline!' });
      bot.sendMessage(chatId, 
        `⚠️ *Device Offline*\n\n` +
        `${dev.name} is currently offline.\n` +
        `Cannot control this device.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    bot.answerCallbackQuery(query.id, { text: '🔄 Syncing...' }).catch(() => {});
    
    // Mark sync in progress to skip notifications
    syncInProgress.add(dev.id);
    
    // Request sync from device
    mqttClient.publish(`device/${dev.id}/command/sync`, '1', { qos: 0 });
    
    // Wait for sync response
    await new Promise(resolve => setTimeout(resolve, 600));
    
    await bot.editMessageText(`🏠 *${dev.name}*\n\nSelect:`, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      reply_markup: getSwitchKeyboard(idx)
    });
    
    // Remove sync flag after delay
    setTimeout(() => syncInProgress.delete(dev.id), 1000);
  }
  
  // Toggle switch
  else if (data.startsWith('t')) {
    const idx = parseInt(data.charAt(1));
    const sw = parseInt(data.charAt(2)) - 1;
    const dev = devices[idx];
    
    if (!dev) {
      bot.answerCallbackQuery(query.id, { text: '❌ Device not found' });
      return;
    }
    
    dev.switches[sw] = !dev.switches[sw];
    const newState = dev.switches[sw];
    
    const emoji = newState ? '🟢' : '⚪';
    bot.answerCallbackQuery(query.id, { text: `${emoji} SW${sw+1} ${newState ? 'ON' : 'OFF'}` });
    
    bot.editMessageReplyMarkup(getSwitchKeyboard(idx), {
      chat_id: chatId,
      message_id: msgId
    }).catch(() => {});
    
    controlDevice(dev.id, sw + 1, newState, true);
  }
  
  // All ON/OFF
  else if (data.startsWith('on') || data.startsWith('off')) {
    const idx = parseInt(data.substring(data.startsWith('on') ? 2 : 3));
    const state = data.startsWith('on');
    const dev = devices[idx];
    
    if (!dev) {
      bot.answerCallbackQuery(query.id, { text: '❌ Device not found' });
      return;
    }
    
    for (let i = 0; i < 4; i++) {
      dev.switches[i] = state;
      controlDevice(dev.id, i + 1, state, true);
    }
    
    bot.answerCallbackQuery(query.id, { text: state ? '🟢 All ON' : '⚪ All OFF' });
    bot.editMessageReplyMarkup(getSwitchKeyboard(idx), {
      chat_id: chatId,
      message_id: msgId
    }).catch(() => {});
  }
  
  // All devices ON/OFF
  else if (data === 'aon' || data === 'aoff') {
    const state = data === 'aon';
    
    for (const dev of devices) {
      for (let i = 0; i < 4; i++) {
        dev.switches[i] = state;
        controlDevice(dev.id, i + 1, state, true);
      }
    }
    
    bot.answerCallbackQuery(query.id, { text: state ? '🟢 All Devices ON' : '⚪ All Devices OFF' });
  }
  
  // Rename device (MUST be before 'r' handler)
  else if (data.startsWith('rn_')) {
    const deviceId = data.substring(3);
    console.log(`DEBUG Rename: deviceId="${deviceId}", devices.length=${devices.length}`);
    const device = devices.find(d => d.id === deviceId);
    console.log(`DEBUG Rename: device found=${!!device}`);
    
    if (!device) {
      bot.answerCallbackQuery(query.id, { text: '❌ Device not found' });
      return;
    }
    
    bot.answerCallbackQuery(query.id).catch(() => {});
    
    bot.sendMessage(chatId,
      `✏️ *Rename Device*\n\n` +
      `Current name: *${device.name.replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&')}*\n` +
      `ID: \`${device.id.replace(/_/g, '\\_')}\`\n\n` +
      `Reply with new name:`,
      { parse_mode: 'Markdown' }
    );
    
    // Store pending rename
    pendingActions.set(query.from.id.toString(), {
      type: 'rename',
      deviceId: deviceId,
      oldName: device.name
    });
  }
  
  // Toggle Remember State
  else if (data.startsWith('mem_')) {
    const deviceId = data.substring(4);
    const device = devices.find(d => d.id === deviceId);
    
    if (!device) {
      bot.answerCallbackQuery(query.id, { text: '❌ Device not found' });
      return;
    }
    
    // Toggle remember state
    device.rememberState = !device.rememberState;
    saveDevices();
    
    // Send MQTT command to device
    const topic = `device/${deviceId}/command/remember`;
    mqttClient.publish(topic, device.rememberState ? '1' : '0', { qos: 0 });
    
    const emoji = device.rememberState ? '💾' : '❌';
    const status = device.rememberState ? 'ON' : 'OFF';
    bot.answerCallbackQuery(query.id, { text: `${emoji} Remember ${status}` });
    
    console.log(`💾 Remember ${status}: ${deviceId}`);
    
    // Auto refresh devices list
    let text = `📱 *Devices* (${devices.length}/${MAX_DEVICES})\n\n`;
    
    if (devices.length >= WARNING_THRESHOLD) {
      const remaining = MAX_DEVICES - devices.length;
      text += `⚠️ *Warning:* ${remaining} slots remaining\n`;
      if (devices.length >= MAX_DEVICES) {
        text += `❌ *Device limit reached!*\n`;
        text += `Remove devices to add new ones.\n`;
      }
      text += `\n`;
    }
    
    const buttons = [];
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    
    devices.forEach((dev, i) => {
      const statusEmoji = dev.online ? '🟢' : '🔴';
      const remember = dev.rememberState ? '💾' : '❌';
      const escapedId = dev.id.replace(/_/g, '\\_');
      const escapedName = dev.name.replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&');
      const numEmoji = numberEmojis[i] || `${i+1}️⃣`;
      
      text += `${i+1}. ${statusEmoji} *${escapedName}*\n`;
      text += `   ID: \`${escapedId}\`\n`;
      text += `   Remember: ${remember}\n\n`;
      
      buttons.push([
        { text: `${numEmoji} Rename`, callback_data: `rn_${dev.id}` },
        { text: `${numEmoji} ${dev.rememberState ? '💾 ON' : '❌ OFF'}`, callback_data: `mem_${dev.id}` },
        { text: `${numEmoji} Remove`, callback_data: `rm_${dev.id}` }
      ]);
    });
    
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    }).catch(() => {});
  }
  
  // Remove device (MUST be before 'r' handler)
  else if (data.startsWith('rm_')) {
    const deviceId = data.substring(3);
    console.log(`DEBUG Remove: deviceId="${deviceId}", devices.length=${devices.length}`);
    const device = devices.find(d => d.id === deviceId);
    console.log(`DEBUG Remove: device found=${!!device}`);
    
    if (!device) {
      bot.answerCallbackQuery(query.id, { text: '❌ Device not found' });
      return;
    }
    
    bot.answerCallbackQuery(query.id).catch(() => {});
    
    bot.sendMessage(chatId,
      `⚠️ *Remove Device?*\n\n` +
      `Name: *${device.name.replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&')}*\n` +
      `ID: \`${device.id.replace(/_/g, '\\_')}\`\n\n` +
      `Reply /confirm to remove or /cancel`,
      { parse_mode: 'Markdown' }
    );
    
    // Store pending remove
    pendingActions.set(query.from.id.toString(), {
      type: 'remove',
      deviceId: deviceId
    });
  }
  
  // Refresh
  else if (data.startsWith('r')) {
    const idx = parseInt(data.substring(1));
    const dev = devices[idx];
    
    if (!dev) {
      bot.answerCallbackQuery(query.id, { text: '❌ Device not found' });
      return;
    }
    
    bot.answerCallbackQuery(query.id, { text: '🔄 Refreshing...' }).catch(() => {});
    
    // Mark sync in progress to skip notifications
    syncInProgress.add(dev.id);
    
    // Request sync from device
    mqttClient.publish(`device/${dev.id}/command/sync`, '1', { qos: 0 });
    
    // Wait for sync response
    await new Promise(resolve => setTimeout(resolve, 600));
    
    await bot.editMessageReplyMarkup(getSwitchKeyboard(idx), {
      chat_id: chatId,
      message_id: msgId
    }).catch(() => {});
    
    // Remove sync flag after delay
    setTimeout(() => syncInProgress.delete(dev.id), 1000);
  }
  
  // Back
  else if (data === 'bk') {
    bot.answerCallbackQuery(query.id).catch(() => {});
    await bot.editMessageText('💡 *Control*\n\nSelect device:', {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      reply_markup: getDeviceKeyboard()
    });
  }
  
  // Device Web UI List
  else if (data === 'webui') {
    bot.answerCallbackQuery(query.id).catch(() => {});
    
    if (devices.length === 0) {
      bot.sendMessage(chatId, '❌ No devices registered');
      return;
    }
    
    let text = '📱 *Device Web UI*\n\n';
    text += '⚠️ Requires same WiFi network\n\n';
    
    const buttons = [];
    
    devices.forEach((dev, i) => {
      const status = dev.online ? '🟢' : '🔴';
      const ip = dev.ip || 'unknown';
      text += `${i+1}. ${status} ${dev.name}\n`;
      text += `   IP: \`${ip}\`\n\n`;
      
      buttons.push([{
        text: `🌐 ${dev.name}`,
        callback_data: `web_${dev.id}`
      }]);
    });
    
    buttons.push([{ text: '⬅️ Back', callback_data: 'bk' }]);
    
    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
  }
  
  // Pagination
  else if (data.startsWith('page')) {
    const page = parseInt(data.substring(4));
    bot.answerCallbackQuery(query.id).catch(() => {});
    await bot.editMessageText('💡 *Control*\n\nSelect device:', {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      reply_markup: getDeviceKeyboard(page)
    });
  }
  
  // Approve device
  else if (data.startsWith('appr')) {
    const idx = parseInt(data.substring(4));
    const pendingDevice = pending.devices[idx];
    
    if (!pendingDevice) {
      bot.answerCallbackQuery(query.id, { text: '❌ Device not found' });
      return;
    }
    
    // Check limit
    if (devices.length >= MAX_DEVICES) {
      bot.answerCallbackQuery(query.id, { text: `❌ Limit reached (${MAX_DEVICES})` });
      return;
    }
    
    bot.answerCallbackQuery(query.id).catch(() => {});
    
    // Ask for custom name
    bot.sendMessage(chatId, 
      `📝 *Enter device name:*\n\n` +
      `Device ID: \`${pendingDevice.id.replace(/_/g, '\\_')}\`\n\n` +
      `Reply with custom name or /skip to use default.`,
      { parse_mode: 'Markdown' }
    );
    
    // Store pending approval
    pendingActions.set(query.from.id.toString(), {
      type: 'approve_device',
      index: idx,
      deviceId: pendingDevice.id,
      defaultName: pendingDevice.name
    });
  }
  
  // Device Web UI
  else if (data.startsWith('web_')) {
    const deviceId = data.substring(4);
    const device = devices.find(d => d.id === deviceId);
    
    if (!device) {
      bot.answerCallbackQuery(query.id, { text: '❌ Device not found' });
      return;
    }
    
    bot.answerCallbackQuery(query.id).catch(() => {});
    
    const deviceIP = device.ip || 'unknown';
    
    if (deviceIP === 'unknown') {
      bot.sendMessage(chatId,
        `⚠️ *Device IP Unknown*\n\n` +
        `Cannot access ${device.name} web UI.\n\n` +
        `*How to find device IP:*\n` +
        `1. Check your router DHCP list\n` +
        `2. Use network scanner app\n` +
        `3. Check device serial monitor\n\n` +
        `*Requirements:*\n` +
        `• Same WiFi network as device\n` +
        `• Device must be online`,
        { parse_mode: 'Markdown' }
      );
    } else {
      const url = `http://${deviceIP}`;
      const statusEmoji = device.online ? '✅' : '❌';
      
      bot.sendMessage(chatId,
        `🌐 *${device.name} Web UI*\n\n` +
        `URL: ${url}\n` +
        `Status: ${statusEmoji} ${device.online ? 'Online' : 'Offline'}\n\n` +
        `⚠️ *Requirements:*\n` +
        `• Same WiFi network\n` +
        `• Device must be online\n\n` +
        `Click button below to open:`,
        { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🌐 Open Web UI', url: url }
            ]]
          }
        }
      );
    }
  }
  
  // Approve user
  else if (data.startsWith('appu')) {
    const idx = parseInt(data.substring(4));
    const pendingUser = pending.users[idx];
    
    if (!pendingUser) {
      bot.answerCallbackQuery(query.id, { text: '❌ User not found' });
      return;
    }
    
    // Add to users
    users.push(pendingUser.id);
    saveUsers();
    
    // Remove from pending
    pending.users.splice(idx, 1);
    savePending();
    
    bot.answerCallbackQuery(query.id, { text: '✅ User approved' });
    bot.sendMessage(chatId, `✅ User approved: ${pendingUser.name}`);
    bot.sendMessage(pendingUser.id, '✅ Your registration has been approved! Use /help to get started.');
    console.log(`✅ User approved: ${pendingUser.id}`);
  }
  
});

// Web Server
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static('public'));
app.use(express.json());

// API: Get devices
app.get('/api/devices', (req, res) => {
  res.json(devices);
});

// API: Control device
app.post('/api/control', (req, res) => {
  const { deviceId, relay, state } = req.body;
  const device = devices.find(d => d.id === deviceId);
  
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }
  
  if (relay < 1 || relay > 4) {
    return res.status(400).json({ error: 'Invalid relay' });
  }
  
  // Update state
  device.switches[relay - 1] = state;
  controlDevice(deviceId, relay, state);
  
  // Broadcast to all clients
  io.emit('deviceUpdate', { deviceId, relay, state });
  
  res.json({ ok: true });
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('🔌 Web client connected');
  socket.emit('devices', devices);
  
  socket.on('disconnect', () => {
    console.log('❌ Web client disconnected');
  });
});



const PORT = 3000;
const os = require('os');

// Get local IP
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('🚀 Bridge Telegram V1 Started!');
  console.log('📱 Devices:', devices.length);
  console.log('👥 Users:', users.length);
  console.log('✅ Bot ready!');
  console.log(`🌐 Web UI (Local): http://localhost:${PORT}`);
  console.log(`📱 Web UI (Network): http://${localIP}:${PORT}`);
  console.log(`\n💡 Akses dari Android: http://${localIP}:${PORT}`);
});

// Offline detection - check every 30 seconds
setInterval(() => {
  const now = Date.now();
  devices.forEach(dev => {
    if (dev.online && dev.lastSeen && (now - dev.lastSeen) > OFFLINE_TIMEOUT) {
      dev.online = false;
      console.log(`🔴 ${dev.id} offline (timeout)`);
    }
  });
}, 30000);
