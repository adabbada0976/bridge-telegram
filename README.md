# Bridge Telegram V1

Smart Home Telegram Bot dengan Auto Discovery & User Management

## ✨ Fitur Baru

### 1. Command Menu Button (☰)
- Tombol menu permanen di Telegram
- Akses cepat ke semua command

### 2. Auto Device Discovery
- Device baru otomatis terdeteksi via MQTT
- Perlu approval dengan password
- Notifikasi real-time ke semua user

### 3. User Management
- User baru bisa register dengan password
- Perlu approval dari user yang sudah ada
- Admin bisa manage users

## 🔐 Passwords

Default passwords (edit di `config.json`):
- **Device Password**: `device123`
- **User Password**: `user123`

## 📱 Commands

### User Commands:
- `/control` - Control devices
- `/status` - Device status
- `/devices` - List devices
- `/pending` - Pending approvals
- `/users` - List users
- `/register PASSWORD` - Register as new user

### Approval Commands:
- `/approve DEVICE_ID PASSWORD` - Approve device
- `/approveuser USER_ID PASSWORD` - Approve user

### Admin Commands:
- `/removedevice DEVICE_ID` - Remove device
- `/removeuser USER_ID` - Remove user
- `/changepass TYPE PASSWORD` - Change password

## 🚀 Setup

1. **Install dependencies:**
```bash
cd "E:\telegram project\bridge-telegram-v1"
npm install
```

2. **Edit config.json:**
- Set your Telegram token
- Set admin user ID
- Change passwords

3. **Run:**
```bash
npm start
```

## 📊 Flow

### Device Discovery:
```
Device boot → Publish status → Bridge detect → Pending list →
User approve dengan password → Device aktif
```

### User Registration:
```
User baru → /register PASSWORD → Pending list →
User lain approve dengan password → User aktif
```

## 📁 Files

- `bridge.js` - Main bot
- `config.json` - Configuration
- `devices.json` - Approved devices
- `users.json` - Authorized users
- `pending.json` - Pending approvals

## 🔄 Update dari V0

- ✅ Command menu button
- ✅ Auto device discovery
- ✅ User management
- ✅ Password protection
- ✅ Persistent storage (JSON files)
- ✅ Real-time notifications
