# Quick Reference - Bridge.js Device Management

## 🚀 Quick Actions

### Approve Device
```
1. /pending
2. Click [✅ Approve]
3. Type: "Ruang Tamu"
4. Done! ✅
```

### Rename Device
```
1. /devices
2. Click [✏️ Rename]
3. Type: "Kamar Tidur Utama"
4. Done! ✅
```

### Remove Device
```
1. /devices
2. Click [🗑️ Remove]
3. /confirm
4. Done! ✅
```

---

## 📊 Device Limits

| Status | Count | Action |
|--------|-------|--------|
| ✅ OK | 0-19 | Normal |
| ⚠️ Warning | 20-24 | Consider cleanup |
| ❌ Full | 25 | Must remove first |

---

## 🎮 Commands

| Command | Description |
|---------|-------------|
| `/control` | Control devices |
| `/devices` | Manage devices |
| `/pending` | Approve new devices |
| `/status` | Check device status |
| `/confirm` | Confirm action |
| `/cancel` | Cancel action |
| `/skip` | Use default name |

---

## 💡 Tips

✅ **Nama device:** Pakai spasi untuk readability
- Good: "Ruang Tamu", "Kamar Tidur 1"
- Bad: "ruang_tamu", "kmr_tdr_1"

✅ **Organize:** Group by location
- "Lantai 1 - Ruang Tamu"
- "Lantai 2 - Kamar Tidur"

✅ **Cleanup:** Remove offline devices regularly

⚠️ **Limit:** Keep under 20 devices for best performance

---

## 🔥 Shortcuts

**Approve with default name:**
```
/pending → Click [Approve] → /skip
```

**Quick remove:**
```
/devices → Click [Remove] → /confirm
```

**Cancel any action:**
```
/cancel
```

---

## 📱 Mobile-Friendly

All actions work with buttons - no typing needed! 🎉
