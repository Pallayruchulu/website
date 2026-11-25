// Tiny JSON-file database. Single process, synchronous, atomic writes.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_PRODUCTS = [
  { id: 'idly-batter', name: 'Idly Batter', telugu: 'ఇడ్లీ పిండి', desc: 'Soft, fluffy idlis every time. Stone-ground from premium rice & urad dal, naturally fermented.', unit: '1 kg pack', price: 80, stock: 50, lowStockAt: 10, active: true, emoji: '⚪', tag: 'Bestseller' },
  { id: 'dosa-batter', name: 'Dosa Batter', telugu: 'దోశ పిండి', desc: 'Crispy golden dosas with that perfect tang. No soda, no preservatives.', unit: '1 kg pack', price: 80, stock: 50, lowStockAt: 10, active: true, emoji: '🌕', tag: 'Crispy' },
  { id: 'millet-dosa', name: 'Millet Dosa Batter', telugu: 'చిరుధాన్యాల దోశ పిండి', desc: 'Healthy mix of millets — high fibre, low GI, full of village goodness.', unit: '1 kg pack', price: 110, stock: 30, lowStockAt: 8, active: true, emoji: '🌾', tag: 'Healthy' },
  { id: 'chapati', name: 'Chapati', telugu: 'చపాతీ', desc: 'Ready-to-cook soft whole-wheat chapatis. Just heat on tawa and serve.', unit: 'Pack of 10', price: 60, stock: 40, lowStockAt: 10, active: true, emoji: '🫓', tag: 'Ready to cook' },
  { id: 'poori', name: 'Poori', telugu: 'పూరీ', desc: 'Ready-to-fry pooris that puff up golden every time.', unit: 'Pack of 10', price: 60, stock: 40, lowStockAt: 10, active: true, emoji: '🥯', tag: 'Ready to fry' }
];

const DEFAULT_SETTINGS = {
  shopName: 'Pallay Ruchulu',
  phone: '+91 90000 00000',
  whatsapp: '919000000000',
  upiId: 'pallayruchulu@upi',
  address: 'SYN No. 157168, Part Grampanchayat, Sri Sai Balaji Foods Pvt Ltd, Shop No G-3, Qutubullapur, Nizampet, Hyderabad, Telangana 500090',
  hours: 'Open daily · 6 AM – 8 PM',
  deliveryCharge: 20,
  freeDeliveryAbove: 300,
  rating: 5.0,
  reviews: 41
};

function emptyDb() {
  return {
    products: JSON.parse(JSON.stringify(DEFAULT_PRODUCTS)),
    orders: [],
    movements: [],
    settings: { ...DEFAULT_SETTINGS },
    nextOrderNo: 1001
  };
}

let db = null;

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    db = emptyDb();
    save();
  } else {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
  }
  return db;
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function get() { return db || load(); }

module.exports = { load, save, get, emptyDb, DB_FILE };
