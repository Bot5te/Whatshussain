const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const express = require("express");
const path = require("path");
const fs = require("fs").promises;
const app = express();

// 🔹 الجروب المستهدف لتحويل الرسائل
const TARGET_GROUP = "120363403583957683@g.us"; // معرف الجروب من الرابط: https://chat.whatsapp.com/LtHfE2bNiw80dMPzOMpAyi
global.qrCodeUrl = null;

// 🔹 دالة لتسجيل اللوغ في ملف
async function logToFile(message) {
    try {
        await fs.appendFile("bot.log", `${new Date().toISOString()} - ${message}\n`);
    } catch (error) {
        console.error(`❌ فشل تسجيل اللوغ: ${error.message}`);
    }
}

// 🔹 دالة الاتصال بواتساب
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", handleConnectionUpdate);

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // 🔹 تحديد ما إذا كانت الرسالة من جروب
        const isGroupMessage = msg.key.remoteJid.endsWith("@g.us");
        let sender = isGroupMessage ? msg.key.participant : msg.key.remoteJid;

        // 🔹 التحقق من LID ومحاولة استخراج رقم الهاتف
        let senderNumber;
        if (isGroupMessage && sender && sender.endsWith("@lid")) {
            console.warn(`⚠️ معرف LID (${sender}) تم الكشف عنه. قد لا يكون رقم الهاتف متاحًا.`);
            await logToFile(`LID detected: ${sender}, message will be skipped unless phone number is found`);
            // محاولة استخراج رقم الهاتف من messageStubParameters
            const phoneNumber = msg.messageStubParameters?.find(param => param.includes("@s.whatsapp.net"))?.split("@")[0] || null;
            if (!phoneNumber) {
                console.error(`❌ معرف LID (${sender}) بدون رقم هاتف متاح! الرسالة لن يتم توجيهها.`);
                await logToFile(`Skipped message from LID ${sender}: No phone number available`);
                return;
            }
            senderNumber = phoneNumber;
        } else if (sender) {
            senderNumber = sender.split("@")[0];
        } else {
            console.error("❌ لا يمكن تحديد المرسل لهذه الرسالة!");
            await logToFile("Skipped message: No sender identified");
            return;
        }

        // 🔹 تسجيل معلومات للتصحيح
        const logMessage = `Message received: remoteJid=${msg.key.remoteJid}, participant=${msg.key.participant}, isGroup=${isGroupMessage}, sender=${sender}, senderNumber=${senderNumber}`;
        console.log(logMessage);
        await logToFile(logMessage);

        let text;
        try {
            text = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                ""
            ).trim();
        } catch (error) {
            console.error(`❌ فشل فك تشفير الرسالة من ${senderNumber}: ${error.message}`);
            await logToFile(`Decryption failed for ${senderNumber}: ${error.message}`);
            return; // تخطي الرسائل التي لا يمكن فك تشفيرها
        }

        // 🔹 التحقق من وجود الكلمات المفتاحية وعدم وجود أي رابط لوكيشن
        const keywords = ["الزبون", "المشتري", "المشترى", "مطلوب"];
        const containsKeyword = keywords.some(keyword => text.includes(keyword));
        const containsLocationLink = /https?:\/\/.*(maps|location|goo\.gl\/maps|maps\.app\.goo\.gl|maps\.google\.com|maps\.apple\.com)/i.test(text);

        if (containsKeyword && !containsLocationLink) {
            // 🔹 إعادة توجيه الرسالة إلى الجروب مع رابط محادثة المرسل
            const forwardedMessage = `رسالة من: https://wa.me/${senderNumber}\n\n${text}`;
            console.log(`Forwarding message from ${senderNumber}: ${text}`);
            await logToFile(`Forwarding message from ${senderNumber}: ${text}`);
            await sock.sendMessage(TARGET_GROUP, { text: forwardedMessage });
        } else {
            const reason = `Keywords: ${containsKeyword}, Location Link: ${containsLocationLink}`;
            console.log(`Message not forwarded from ${senderNumber}. ${reason}`);
            await logToFile(`Message not forwarded from ${senderNumber}. ${reason}`);
        }
    });
}

// 🔹 معالجة حالة الاتصال
function handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
        console.log("✅ تم توليد رمز QR! امسحه للاتصال.");
        qrcode.toDataURL(qr, (err, url) => {
            if (err) console.error("❌ خطأ في إنشاء QR:", err);
            global.qrCodeUrl = url;
        });
    }

    if (connection === "close") {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
        console.log("🚨 تم فصل الاتصال، جارٍ إعادة الاتصال...", shouldReconnect);
        if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
    } else if (connection === "open") {
        console.log("✅ تم الاتصال بنجاح!");
        global.qrCodeUrl = null; // مسح رمز QR بعد الاتصال الناجح
    }
}

// 🔹 إعدادات السيرفر
app.use(express.json());
app.use("/panel", express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.send(global.qrCodeUrl
        ? `<h1>امسح رمز QR للاتصال بالبوت</h1><img src="${global.qrCodeUrl}" width="300">`
        : "<h1>لم يتم توليد رمز QR بعد... يرجى الانتظار!</h1>");
});

app.listen(3000, () => console.log("🚀 السيرفر يعمل على http://localhost:3000"));
connectToWhatsApp();
