const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState, Browsers } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const express = require("express");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const axios = require("axios");
const mime = require("mime-types");

const app = express();

// ====== Directories (for compatibility, but not used for storage) ======
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

for (const dir of [DATA_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ====== In-memory State ======
global.qrCodeUrl = null;
const respondedMessages = new Map(); // sender -> state string
const customerServiceSessions = new Map(); // sessionId -> { customerJid, expiresAt, timeout, type: 'general' }
const pendingData = new Map(); // sender -> { area, details: [], name: '' }
const lastMessageTimestamps = new Map();
const lastOrderTimestamps = new Map(); // sender -> timestamp of last order
const userLanguages = new Map(); // sender -> 'ar' or 'en'
const INACTIVITY_TIMEOUT = 2* 60 * 60 * 1000; // 5 minutes
const IGNORE_OLD_MESSAGES_THRESHOLD = 15 * 60 * 1000; // 15 minutes
const POST_ORDER_GRACE_PERIOD = 2 * 60 * 60 * 1000; // 30 minutes after order to suppress welcome
const FEEDBACK_TIMEOUT = 10 * 60 * 1000; // 10 minutes for feedback
const REVIEW_TIMEOUT = 2 * 60 * 60 * 1000; //
// ====== GitHub Gist options ======
const GIST_ID = "1050e1f10d7f5591f4f26ca53f2189e9";
const token_part1 = "ghp_gFkAlF";
const token_part2 = "A4sbNyuLtX";
const token_part3 = "YvqKfUEBHXNaPh3ABRms";
const GITHUB_TOKEN = token_part1 + token_part2 + token_part3;

async function readData(filename) {
  try {
    const response = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });
    const data = JSON.parse(response.data.files[filename]?.content || '{}');
    return data;
  } catch (e) {
    console.error(`❌ خطأ في قراءة ${filename} من Gist:`, e.message);
    return {};
  }
}

async function writeData(filename, data) {
  try {
    await axios.patch(
      `https://api.github.com/gists/${GIST_ID}`,
      { files: { [filename]: { content: JSON.stringify(data, null, 2) } } },
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );
  } catch (e) {
    console.error(`❌ فشل حفظ ${filename} إلى Gist:`, e.message);
  }
}

async function readOrders() {
  const data = await readData("orders.json");
  return { orders: Array.isArray(data.orders) ? data.orders : [] };
}

async function writeOrders(data) {
  await writeData("orders.json", data);
}

async function readArchivedOrders() {
  const data = await readData("archived_orders.json");
  return { orders: Array.isArray(data.orders) ? data.orders : [] };
}

async function writeArchivedOrders(data) {
  await writeData("archived_orders.json", data);
}

async function readReviews() {
  const data = await readData("reviews.json");
  return { reviews: Array.isArray(data.reviews) ? data.reviews : [] };
}

async function writeReviews(data) {
  await writeData("reviews.json", data);
}

// ====== Helpers ======
function convertArabicToEnglishNumbers(text) {
  const arabicNumbers = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
  return text.replace(/[٠-٩]/g, d => arabicNumbers.indexOf(d));
}

function generateSessionId() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function generateOrderId() {
  return Math.floor(10000000 + Math.random() * 90000000).toString(); // 8-digit numeric ID
}

function generateReviewId() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit numeric ID
}

async function upsertOrder(order) {
  const data = await readOrders();
  // Check for ID collision (rare, but to be safe)
  while (data.orders.some(o => o.id === order.id)) {
    order.id = generateOrderId();
  }
  const idx = data.orders.findIndex(o => o.id === order.id);
  if (idx >= 0) {
    data.orders[idx] = order;
  } else {
    data.orders.push(order);
  }
  await writeOrders(data);
}

async function upsertReview(review) {
  const data = await readReviews();
  while (data.reviews.some(r => r.id === review.id)) {
    review.id = generateReviewId();
  }
  data.reviews.push(review);
  await writeReviews(data);
}

function getStatusText(status, lang = 'ar') {
  if (lang === 'en') {
    switch (status) {
      case "بانتظار التأكيد": return "Under Review ⏳";
      case "جاري التحضير": return "Preparing 🍴";
      case "في الطريق": return "On the Way 🚚";
      case "اكتمل": return "Delivered ✅";
      case "ملغى": return "Cancelled ❌";
      default: return "Unknown ❓";
    }
  } else {
    switch (status) {
      case "بانتظار التأكيد": return "قيد المراجعة ⏳";
      case "جاري التحضير": return "قيد التجهيز 🍴";
      case "في الطريق": return "في الطريق 🚚";
      case "اكتمل": return "تم التسليم ✅";
      case "ملغى": return "ملغى ❌";
      default: return "غير معروف ❓";
    }
  }
}

// ====== Branch Configurations (Only Military) ======
const BRANCH = {
  name: "المستشفى العسكري",
  areas: [
    { id: 1, name_ar: "العيادات التخصصية 🏥", name_en: "Specialized Clinics 🏥" },
    { id: 2, name_ar: "توسعة مستشفى الملك فهد 🏗️", name_en: "King Fahd Hospital Expansion 🏗️" },
    { id: 3, name_ar: "مركز طب الأسنان 🦷", name_en: "Dental Center 🦷" }
  ]
};

const CATALOG_LINK = "https://wa.me/c/966573760549";

// ====== Language Texts ======
const TEXTS = {
  ar: {
    welcome: `👋 مرحبًا بك في أنتيكا – فرع المستشفى العسكري ❤️
اختر الخدمة المطلوبة:
1️⃣ طلب جديد (توصيل) 🚚
2️⃣ استعراض المنيو 📋
3️⃣ تتبع الطلب 🔍
4️⃣ خدمة العملاء ☎️
5️⃣ تغيير اللغة 🔄

🏛 للعودة إلى القائمة الرئيسية في أي وقت أرسل: *0*`,
    languagePrompt: `✨ مرحباً بك!  
فضلاً اختر لغتك المفضلة:  

1️⃣ العربية  
2️⃣ ‏‏English`,
    invalidChoice: "👋 مرحبًا بك! الرجاء اختيار رقم من القائمة علشان نقدر نخدمك بشكل أفضل ❤️.",
    deliveryArea: `⏰ الطلب عادة يوصل خلال 20–30 دقيقة بأوقات الذروة، وأحيانًا أسرع 💨👌
الأهم نوّصله لك طازج ولذيذ 😋

✅ الحد الأدنى للطلب 20 ريال  

للمتابعة في إكمال الطلب حدد موقع التوصيل باختيار أحد الأرقام: 🗺️`,
    invalidArea: "⚠️ الرجاء اختيار رقم منطقة صحيح.",
    orderPrompt: `🛒 عزيزي العميل، قم باختيار المنتجات المطلوبة من الكتالوج واضغط إرسال الطلب. 🍴

⏩️ ${CATALOG_LINK}`,
    namePrompt: "الرجاء ارسال اسمك لتأكيد الطلب",
    orderConfirmation: `⏳ شكرًا لك، طلبك تحت المراجعة حاليًا من مشرف الفرع. 🙏
الرجاء الانتظار قليلاً…`,
    menuLink: `📖 تفضل هذا هو المنيو الخاص بنا: 🍰
${CATALOG_LINK}`,
    trackingPrompt: `🔍 الرجاء إدخال رقم الطلب الخاص بك لمتابعة حالته. 📦`,
    orderNotFound: `⚠️ لا يوجد طلب بهذا الرقم: [ORDER_ID] ❗`,
    orderStatus: `🔔 تحديث حالة طلبك [ORDER_ID]: [STATUS]`,
    supportStart: `💬 شكراً لتواصلك مع [SERVICE_TEXT] 🙏\nسوف نقوم بالرد عليك في أقرب وقت ممكن.\n\n🆔 معرف الجلسة: [SESSION_ID]\n\n🔙 لإنهاء المحادثة والعودة للقائمة الرئيسية أرسل: *0*`,
    endSessionInvalid: "⚠️ يرجى تحديد معرف الجلسة بعد كلمة 'انتهاء' (مثال: انتهاء 1234) ❗",
    endSessionNotFound: `⚠️ لا توجد جلسة بالمعرف [SESSION_ID]. ❗`,
    endSessionSuccess: "✅ تم إنهاء الجلسة. كيف نقدر نخدمك اليوم؟ 👋",
    endSessionAdmin: `✅ تم إنهاء الجلسة ([SESSION_ID]).`,
    orderAccepted: `✅ تم قبول طلبك بنجاح. 🙌
رقم الطلب: [ORDER_ID]
📦 طلبك الآن قيد التجهيز، وسيتم التواصل معك عند الانتهاء. 🍴`,
    orderOnWay: `🔔 تحديث حالة طلبك [ORDER_ID]: في الطريق 🚚`,
    orderDelivered: `🔔 تحديث حالة طلبك [ORDER_ID]: تم التسليم ✅`,
    orderCancelled: `🔔 تحديث حالة طلبك [ORDER_ID]: ملغى ❌`,
    orderUpdate: `🔔 تحديث حالة طلبك [ORDER_ID]: [STATUS]`,
    reviewPrompt: `كيف تقيّم طلبك اليوم؟\n1️⃣ غير راضي \n2️⃣ مقبولة 🙂\n3️⃣ تحتاج تحسين 🤔\n4️⃣ ممتازة 🤩`,
    reviewResponse1: `📩 تقييم: 1️⃣ غير راضي\n\nنعتذر لك جدًا 🙏 تجربتك تهمنا وودنا نسمع ملاحظتك عشان نطور ونخدمك بشكل أفضل 🌿`,
    reviewResponse2: `📩 تقييم: 2️⃣ 🙂 مقبولة\n\nشكرًا لتقييمك 🌸 نطمح نوصل لتجربة ترضيك أكثر المرات الجاية، إذا عندك ملاحظة شاركنا 💡`,
    reviewResponse3: `📩 تقييم: 3️⃣ 🤔 تحتاج تحسين\n\nوصلت رسالتك 👍 نقدر صراحتك وراح نهتم بتطوير نقاط التحسين عشان تجربتك القادمة تكون أفضل 👌`,
    reviewResponse4: `📩 تقييم: 4️⃣ 🤩 ممتازة\n\nياهلا 🌟 شكرًا على كلامك اللي يفرحنا 🙏 سعيدين إن التجربة أعجبتك ونوعدك نستمر بنفس المستوى وأحسن 🧡`,
    invalidReview: `⚠️ الرجاء اختيار رقم من 1 إلى 4.`
  },
  en: {
    welcome: `👋 Welcome to Antika - Military Hospital Branch ❤️
Choose the desired service:
1️⃣ New Order (Delivery) 🚚
2️⃣ View Menu 📋
3️⃣ Track Order 🔍
4️⃣ Customer Service ☎️
5️⃣ Change Language 🔄

🏛 To return to the main menu at any time, send: *0*`,
    languagePrompt: `✨ Welcome to Antika Restaurant ❤️
Please choose your preferred language:  

1️⃣ ‎Arabic  
2️⃣ ‎English`,
    invalidChoice: "👋 Hello! Please select a number from the menu so we can serve you better ❤️.",
    deliveryArea: `⏰ Orders usually arrive within 20–30 minutes during peak times, and sometimes even faster 💨👌  
The most important thing is that we deliver it fresh and delicious 😋  

To continue placing your order, please select your delivery area by choosing one of the numbers: 🗺️`,
    invalidArea: "⚠️ Please select a valid area number.",
    orderPrompt: `🛒 Dear customer, make sure to select the desired products from the catalog and press confirm order. 🍴

⏩️ ${CATALOG_LINK}`,
    namePrompt: "Please send your name to confirm the order",
    orderConfirmation: `⏳ Thank you, your order is currently under review by the branch supervisor. 🙏
Please wait a moment…`,
    menuLink: `📖 Here is our menu: 🍰
${CATALOG_LINK}`,
    trackingPrompt: `🔍 Please enter your order number to track its status. 📦`,
    orderNotFound: `⚠️ No order found with this number: [ORDER_ID] ❗`,
    orderStatus: `🔔 Update on your order [ORDER_ID]: [STATUS]`,
    supportStart: `💬 Thank you for contacting [SERVICE_TEXT] 🙏\nWe will respond to you as soon as possible.\n\n🆔 Session ID: [SESSION_ID]\n\n🔙 To end the conversation and return to the main menu, send: *0*`,
    endSessionInvalid: "⚠️ Please specify the session ID after 'انتهاء' (example: انتهاء 1234) ❗",
    endSessionNotFound: `⚠️ No session found with ID [SESSION_ID]. ❗`,
    endSessionSuccess: "✅ Session ended. How can we help you today? 👋",
    endSessionAdmin: `✅ Session ended ([SESSION_ID]).`,
    orderAccepted: `✅ Your order has been accepted successfully. 🙌
Order number: [ORDER_ID]
📦 Your order is now being prepared, and we will contact you when it's ready. 🍴`,
    orderOnWay: `🔔 Update on your order [ORDER_ID]: On the Way 🚚`,
    orderDelivered: `🔔 Update on your order [ORDER_ID]: Delivered ✅`,
    orderCancelled: `🔔 Update on your order [ORDER_ID]: Cancelled ❌`,
    orderUpdate: `🔔 Update on your order [ORDER_ID]: [STATUS]`,
    reviewPrompt: `How would you rate your order today?\n1️⃣ Not satisfied \n2️⃣ Acceptable 🙂\n3️⃣ Needs improvement 🤔\n4️⃣ Excellent 🤩`,
    reviewResponse1: `📩 Rating: 1️⃣ Not satisfied\n\nWe are very sorry 🙏 Your experience matters to us, and we'd love to hear your feedback to improve and serve you better 🌿`,
    reviewResponse2: `📩 Rating: 2️⃣ 🙂 Acceptable\n\nThank you for your rating 🌸 We aim to provide a more satisfying experience next time, if you have any suggestions, share with us 💡`,
    reviewResponse3: `📩 Rating: 3️⃣ 🤔 Needs improvement\n\nMessage received 👍 We appreciate your honesty and will work on improving for a better next experience 👌`,
    reviewResponse4: `📩 Rating: 4️⃣ 🤩 Excellent\n\nHello 🌟 Thank you for your kind words that make us happy 🙏 We're glad you enjoyed the experience and promise to maintain or improve 🧡`,
    invalidReview: `⚠️ Please select a number from 1 to 4.`
  }
};

// ====== WhatsApp Connection ======
let sock;
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS("Safari")
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", handleConnectionUpdate);
  sock.ev.on("messages.upsert", handleMessagesUpsert);
}

function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;
  if (qr) {
    qrcode.toDataURL(qr, (err, url) => {
      if (err) return console.error("❌ خطأ في إنشاء QR:", err);
      global.qrCodeUrl = url;
    });
  }
  if (connection === "close") {
    const code = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect = code !== 401;
    console.log("🚨 تم فصل الاتصال، سيتم المحاولة مجددًا:", shouldReconnect, code);
    if (shouldReconnect) setTimeout(connectToWhatsApp, 30000);
  } else if (connection === "open") {
    console.log("✅ تم الاتصال بنجاح!");
  }
}

async function handleMessagesUpsert({ messages }) {
  const msg = messages[0];
  if (!msg || !msg.message) return;

  const sender = msg.key.remoteJid;
  if (sender.endsWith("@g.us")) return;

  const messageTimestamp = msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now();
  if (messageTimestamp < Date.now() - IGNORE_OLD_MESSAGES_THRESHOLD) return;

  let messageContent = '';
  if (msg.message.conversation) {
    messageContent = msg.message.conversation;
  } else if (msg.message.extendedTextMessage) {
    messageContent = msg.message.extendedTextMessage.text;
  } else if (msg.message.orderMessage) {
    const order = msg.message.orderMessage;
    messageContent = 'طلب من الكتالوج:\n';
    if (order.message) messageContent += `${order.message}\n`;
    messageContent += `عدد العناصر: ${order.itemCount}\n`;
    if (order.items && order.items.length > 0) {
      messageContent += 'التفاصيل:\n';
      order.items.forEach(item => {
        messageContent += `${item.quantity} x ${item.title} - ${item.price1000 / 1000} ${item.currency}\n`;
        if (item.description) messageContent += `وصف: ${item.description}\n`;
      });
    }
    messageContent += `الإجمالي: ${order.totalAmount1000 / 1000} ${order.totalCurrencyCode}`;
  }

  let text = convertArabicToEnglishNumbers(messageContent.trim());
  const isFromMe = msg.key.fromMe;

  // Support emoji numbers in text (e.g., "1️⃣" -> "1")
  text = text.replace(/([1-5])️⃣/g, '$1');

  try {
    if (text.startsWith("انتهاء ")) {
      await handleEndSession(text, sender);
      return;
    }

    if (text === "📌") {
      const silent = isFromMe;
      await startCustomerService(sender, "general", silent);
      return;
    }

    if (isFromMe) return;

    if (!respondedMessages.has(sender)) {  
      await sendLanguagePrompt(sender);  
      respondedMessages.set(sender, "LANGUAGE_SELECTION");  
      lastMessageTimestamps.set(sender, Date.now());  
      return;  
    }  

    await routeExistingUser(sender, text);
  } catch (e) {
    console.error("❌ خطأ في معالجة الرسالة:", e);
  } finally {
    lastMessageTimestamps.set(sender, Date.now());
  }
}

// ====== Bot Flows ======
async function sendLanguagePrompt(jid) {
  const text = TEXTS.ar.languagePrompt; // Using AR version as it's bilingual
  await sock.sendMessage(jid, { text });
  lastMessageTimestamps.set(jid, Date.now());
}

async function sendWelcomeMenu(jid) {
  const lang = userLanguages.get(jid) || 'ar';
  const text = TEXTS[lang].welcome;
  await sock.sendMessage(jid, { text });
  lastMessageTimestamps.set(jid, Date.now());
}

async function routeExistingUser(sender, text) {
  const state = respondedMessages.get(sender);
  const lang = userLanguages.get(sender) || 'ar';

  if (text === "0") {
    if (state === "CUSTOMER_SERVICE") {
      const sessions = Array.from(customerServiceSessions.values()).filter(s => s.customerJid === sender);
      for (const session of sessions) {
        clearTimeout(session.timeout);
        customerServiceSessions.delete(session.sessionId);
      }
    }
    respondedMessages.set(sender, "MAIN_MENU");
    pendingData.delete(sender);
    return sendWelcomeMenu(sender);
  }

  const lastTime = lastMessageTimestamps.get(sender) || 0;
  const lastOrderTime = lastOrderTimestamps.get(sender) || 0;
  if (Date.now() - lastTime > INACTIVITY_TIMEOUT && state !== "CUSTOMER_SERVICE" && Date.now() - lastOrderTime > POST_ORDER_GRACE_PERIOD) {
    await sendWelcomeMenu(sender);
    lastMessageTimestamps.set(sender, Date.now());
    return;
  }

  if (state === "LANGUAGE_SELECTION") {
    if (text === "1") {
      userLanguages.set(sender, 'ar');
      await sock.sendMessage(sender, { text: "تم اختيار العربية ✅" });
    } else if (text === "2") {
      userLanguages.set(sender, 'en');
      await sock.sendMessage(sender, { text: "English selected ✅" });
    } else {
      await sock.sendMessage(sender, { text: lang === 'ar' ? "⚠️ الرجاء اختيار 1 أو 2." : "⚠️ Please choose 1 or 2." });
      return;
    }
    respondedMessages.set(sender, "MAIN_MENU");
    await sendWelcomeMenu(sender);
    return;
  }

  if (state === "MAIN_MENU") {
    if (text === "1") return startDeliveryFlow(sender);
    if (text === "2") return handleShowMenu(sender);
    if (text === "3") return startTrackingFlow(sender);
    if (text === "4") return startCustomerService(sender, "general");
    if (text === "5") {
      respondedMessages.set(sender, "LANGUAGE_SELECTION");
      return sendLanguagePrompt(sender);
    }
    await sock.sendMessage(sender, { text: TEXTS[lang].invalidChoice });
    await sendWelcomeMenu(sender);
    return;
  }

  if (state === "DELIVERY_AREA") {
    const areas = BRANCH.areas;
    const selectedArea = areas.find(a => a.id.toString() === text);
    if (!selectedArea) {
      await sock.sendMessage(sender, { text: TEXTS[lang].invalidArea });
      return;
    }
    const areaName = lang === 'ar' ? selectedArea.name_ar : selectedArea.name_en;
    await handleAreaSelected(sender, areaName);
    return;
  }

  if (state === "AWAITING_ORDER") {
    if (text.startsWith("طلب من الكتالوج:")) {
      pendingData.set(sender, { ...pendingData.get(sender), details: text });
      await sock.sendMessage(sender, { text: TEXTS[lang].namePrompt });
      respondedMessages.set(sender, "AWAITING_NAME");
      return;
    }
  }

  if (state === "AWAITING_NAME") {
    pendingData.set(sender, { ...pendingData.get(sender), name: text });
    await finalizeOrder(sender);
    return;
  }

  if (state === "TRACKING") {
    await handleTrackOrder(sender, text);
    return;
  }

  if (state === "AWAITING_REVIEW") {
    await handleReview(sender, text);
    return;
  }

  if (state === "AWAITING_FEEDBACK") {
    await handleFeedback(sender, text);
    return;
  }

  if (state === "CUSTOMER_SERVICE") {
    // Allow messages in customer service without interruption
    return;
  }
}

async function startDeliveryFlow(jid) {
  const lang = userLanguages.get(jid) || 'ar';
  const areasText = BRANCH.areas.map(a => `${a.id}. ${lang === 'ar' ? a.name_ar : a.name_en}`).join("\n\t");
  const text = `${TEXTS[lang].deliveryArea}\n\t${areasText}`;
  await sock.sendMessage(jid, { text });
  respondedMessages.set(jid, "DELIVERY_AREA");
}

async function handleAreaSelected(jid, areaName) {
  const lang = userLanguages.get(jid) || 'ar';
  const text = TEXTS[lang].orderPrompt;
  await sock.sendMessage(jid, { 
    text,
    linkPreview: {
      title: lang === 'ar' ? 'كتالوج المطعم 📋' : 'Restaurant Catalog 📋',
      body: lang === 'ar' ? 'تصفح الأصناف والعروض 🎉' : 'Browse items and offers 🎉',
      canonicalUrl: CATALOG_LINK,
      matchedText: CATALOG_LINK
    }
  });
  respondedMessages.set(jid, "AWAITING_ORDER");
  pendingData.set(jid, { area: areaName, details: "", name: "" });
}

async function finalizeOrder(jid) {
  const lang = userLanguages.get(jid) || 'ar';
  const data = pendingData.get(jid) || { area: null, details: "", name: "" };
  const id = generateOrderId();
  const order = {
    id,
    customerJid: jid,
    area: data.area,
    details: data.details, // هنا يتم حفظ التفاصيل الكاملة للعناصر
    name: data.name,
    status: "بانتظار التأكيد",
    createdAt: new Date().toISOString()
  };
  await upsertOrder(order);

  await sock.sendMessage(jid, { text: TEXTS[lang].orderConfirmation });
  lastOrderTimestamps.set(jid, Date.now()); // Set grace period start
  await startCustomerService(jid, "general", true); // Auto-start support silently
  respondedMessages.set(jid, "CUSTOMER_SERVICE"); // Set to customer service
  pendingData.delete(jid);
}

async function handleShowMenu(jid) {
  const lang = userLanguages.get(jid) || 'ar';
  const text = TEXTS[lang].menuLink;
  await sock.sendMessage(jid, { 
    text,
    linkPreview: {
      title: lang === 'ar' ? 'كتالوج المطعم 📋' : 'Restaurant Catalog 📋',
      body: lang === 'ar' ? 'تصفح الأصناف والعروض 🎉' : 'Browse items and offers 🎉',
      canonicalUrl: CATALOG_LINK,
      matchedText: CATALOG_LINK
    }
  });
  respondedMessages.set(jid, "MAIN_MENU");
}

async function startTrackingFlow(jid) {
  const lang = userLanguages.get(jid) || 'ar';
  const text = TEXTS[lang].trackingPrompt;
  await sock.sendMessage(jid, { text });
  respondedMessages.set(jid, "TRACKING");
}

async function handleTrackOrder(jid, orderId) {
  const lang = userLanguages.get(jid) || 'ar';
  let order = null;
  let data = await readOrders();
  order = data.orders.find(o => o.id === orderId);
  if (!order) {
    data = await readArchivedOrders();
    order = data.orders.find(o => o.id === orderId);
  }
  if (!order) {
    await sock.sendMessage(jid, { text: TEXTS[lang].orderNotFound.replace('[ORDER_ID]', orderId) });
  } else {
    const statusText = getStatusText(order.status, lang);
    await sock.sendMessage(jid, { text: TEXTS[lang].orderStatus.replace('[ORDER_ID]', orderId).replace('[STATUS]', statusText) });
  }
  respondedMessages.set(jid, "MAIN_MENU");
}

async function startCustomerService(jid, type = "general", silent = false) {
  const lang = userLanguages.get(jid) || 'ar';
  const sessionId = generateSessionId();
  const twoHours = 2 * 60 * 60 * 1000;

  const timeout = setTimeout(async () => {
    customerServiceSessions.delete(sessionId);
    respondedMessages.set(jid, "MAIN_MENU");
    
  }, twoHours);

  customerServiceSessions.set(sessionId, { 
    customerJid: jid, 
    expiresAt: Date.now() + twoHours, 
    timeout,
    type
  });

  respondedMessages.set(jid, "CUSTOMER_SERVICE");

  if (!silent) {
    const serviceText = type === "general" ? (lang === 'ar' ? "خدمة العملاء ☎️" : "Customer Service ☎️") : (lang === 'ar' ? "مشرف الفرع 👨‍🍳" : "Branch Supervisor 👨‍🍳");
    await sock.sendMessage(jid, { 
      text: TEXTS[lang].supportStart.replace('[SERVICE_TEXT]', serviceText).replace('[SESSION_ID]', sessionId)
    });
  }
}

async function handleEndSession(text, sender) {
  const lang = userLanguages.get(sender) || 'ar';
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    await sock.sendMessage(sender, { text: TEXTS[lang].endSessionInvalid });
    return;
  }
  const sessionId = parts[1];
  const session = customerServiceSessions.get(sessionId);
  if (!session) {
    await sock.sendMessage(sender, { text: TEXTS[lang].endSessionNotFound.replace('[SESSION_ID]', sessionId) });
    return;
  }
  clearTimeout(session.timeout);
  customerServiceSessions.delete(sessionId);
  respondedMessages.set(session.customerJid, "MAIN_MENU");
  await sock.sendMessage(session.customerJid, { text: TEXTS[lang].endSessionSuccess });
  await sendWelcomeMenu(session.customerJid);
  if (sender !== session.customerJid) {
    await sock.sendMessage(sender, { text: TEXTS[lang].endSessionAdmin.replace('[SESSION_ID]', sessionId) });
  }
}

async function startReviewFlow(jid, orderId) {
  const lang = userLanguages.get(jid) || 'ar';
  const text = TEXTS[lang].reviewPrompt;
  await sock.sendMessage(jid, { text });
  respondedMessages.set(jid, "AWAITING_REVIEW");
  pendingData.set(jid, { orderId }); // Store orderId temporarily
}




// ====== Modified handleReview Function ======
async function handleReview(jid, ratingText) {
  const lang = userLanguages.get(jid) || 'ar';
  const rating = parseInt(ratingText);
  if (isNaN(rating) || rating < 1 || rating > 4) {
    await sock.sendMessage(jid, { text: TEXTS[lang].invalidReview });
    return;
  }

  const orderId = pendingData.get(jid)?.orderId;
  const review = {
    id: generateReviewId(),
    customerJid: jid,
    orderId,
    rating,
    feedback: null,
    createdAt: new Date().toISOString()
  };

  let responseText;
  switch (rating) {
    case 1: responseText = TEXTS[lang].reviewResponse1; break;
    case 2: responseText = TEXTS[lang].reviewResponse2; break;
    case 3: responseText = TEXTS[lang].reviewResponse3; break;
    case 4: responseText = TEXTS[lang].reviewResponse4; break;
  }

  await sock.sendMessage(jid, { text: responseText });

  // Set timeout for review completion (2 hours)
  const reviewTimeout = setTimeout(async () => {
    await upsertReview(review); // Save review even if no feedback provided
    respondedMessages.set(jid, "MAIN_MENU");
    pendingData.delete(jid);
    
  }, REVIEW_TIMEOUT);

  if (rating < 4) {
    respondedMessages.set(jid, "AWAITING_FEEDBACK");
    const feedbackTimeout = setTimeout(async () => {
      await upsertReview(review); // Save review without feedback
      respondedMessages.set(jid, "MAIN_MENU");
      pendingData.delete(jid);
      
    }, FEEDBACK_TIMEOUT);
    pendingData.set(jid, { ...review, timeout: feedbackTimeout });
  } else {
    await upsertReview(review);
    respondedMessages.set(jid, "MAIN_MENU");
    pendingData.delete(jid);
    
  }
}
  

async function handleFeedback(jid, feedbackText) {
  const lang = userLanguages.get(jid) || 'ar';
  const pending = pendingData.get(jid);
  if (!pending) return;

  clearTimeout(pending.timeout);
  pending.feedback = feedbackText;
  await upsertReview(pending);
  await sock.sendMessage(jid, { text: lang === 'ar' ? "شكرًا لملاحظتك! 🌟" : "Thank you for your feedback! 🌟" });
  respondedMessages.set(jid, "MAIN_MENU");
  
  pendingData.delete(jid);
}

// ====== Admin Panel & APIs ======
app.use(express.json());
app.use("/panel", express.static(PUBLIC_DIR));

// Root shows QR code during login
app.get("/", (req, res) => {
  res.send(global.qrCodeUrl
    ? `<h1 style="font-family:Tahoma">امسح رمز QR للاتصال بالبوت</h1><img src="${global.qrCodeUrl}" width="300">`
    : `<h1 style="font-family:Tahoma">لم يتم توليد رمز QR بعد... يرجى الانتظار!</h1>`);
});

// ---- Orders ----
app.get("/api/orders", async (req, res) => {
  const data = await readOrders();
  const status = req.query.status;
  let orders = status ? data.orders.filter(o => o.status === status) : data.orders;
  orders = orders.map(order => ({
    ...order,
    whatsappNumber: order.customerJid.split('@')[0],
    whatsappLink: order.status !== "اكتمل" && order.status !== "ملغى" ? `https://wa.me/${order.customerJid.split('@')[0]}` : null
  }));
  res.json({ orders });
});

app.patch("/api/orders/:id/status", async (req, res) => {
  const id = req.params.id;
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: "status مطلوب" });
  const data = await readOrders();
  const idx = data.orders.findIndex(o => o.id === id);
  if (idx < 0) return res.status(404).json({ error: "طلب غير موجود" });
  const order = data.orders[idx];
  const oldStatus = order.status;
  order.status = status;
  await writeOrders(data);

  const lang = userLanguages.get(order.customerJid) || 'ar';

  try {
    if (status === "جاري التحضير" && oldStatus === "بانتظار التأكيد") {
      await sock.sendMessage(order.customerJid, { text: TEXTS[lang].orderAccepted.replace('[ORDER_ID]', order.id) });
    } else if (status === "في الطريق") {
      await sock.sendMessage(order.customerJid, { text: TEXTS[lang].orderOnWay.replace('[ORDER_ID]', order.id) });
    } else if (status === "اكتمل") {
      await sock.sendMessage(order.customerJid, { text: TEXTS[lang].orderDelivered.replace('[ORDER_ID]', order.id) });
      await startReviewFlow(order.customerJid, order.id); // Start review after delivery
    } else if (status === "ملغى") {
      await sock.sendMessage(order.customerJid, { text: TEXTS[lang].orderCancelled.replace('[ORDER_ID]', order.id) });
    } else {
      await sock.sendMessage(order.customerJid, { text: TEXTS[lang].orderUpdate.replace('[ORDER_ID]', order.id).replace('[STATUS]', getStatusText(status, lang)) });
    }
  } catch (e) {
    console.error("⚠️ فشل إرسال إشعار للعميل:", e.message);
  }

  if (status === "اكتمل") {
    const archivedData = await readArchivedOrders();
    archivedData.orders.push(order);
    await writeArchivedOrders(archivedData);
    data.orders = data.orders.filter(o => o.id !== id);
    await writeOrders(data);
  }

  res.json({ success: true });
});

app.delete("/api/orders/:id", async (req, res) => {
  const id = req.params.id;
  const data = await readOrders();
  const idx = data.orders.findIndex(o => o.id === id);
  if (idx < 0) return res.status(404).json({ error: "طلب غير موجود" });
  data.orders.splice(idx, 1);
  await writeOrders(data);
  res.json({ success: true });
});

// ---- Archived Orders ----
app.get("/api/archived_orders", async (req, res) => {
  const data = await readArchivedOrders();
  res.json(data);
});

// ---- Reviews ----
app.get("/api/reviews", async (req, res) => {
  const data = await readReviews();
  res.json({ reviews: data.reviews });
});

// ====== Start Server & WA ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 السيرفر يعمل على http://localhost:${PORT}`));
connectToWhatsApp();
