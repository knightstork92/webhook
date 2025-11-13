const express = require("express");
const admin = require("firebase-admin");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// ✅ Đọc key từ biến môi trường base64 và Khởi tạo Firebase Admin
const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf8")
);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// 🚨 HẰNG SỐ CẤU HÌNH
const FOLDER_ID = "10vX845ZsB0cfryOHdq17BnkjdY4_MdKk"; 

// ✅ Webhook chính
app.post("/drive-webhook", async (req, res) => {
    const state = req.headers["x-goog-resource-state"];
    const changed = req.headers["x-goog-changed"]; 

    console.log("📩 Webhook được gọi:", JSON.stringify(req.headers, null, 2));
    console.log("📍 Trạng thái:", state);
    console.log("🔄 Changed:", changed);
    
    // 1. Phản hồi ngay lập tức
    res.sendStatus(204); 

    // 2. LỌC HEADER ĐÚNG cho files.watch
    if (state !== "update") {
        console.log(`⏭️ Không phải sự kiện cập nhật thư mục. Bỏ qua trạng thái: ${state}`);
        return;
    }

    try {
        // 3. Google Drive Auth
        const auth = new google.auth.JWT({
            email: serviceAccount.client_email,
            key: serviceAccount.private_key,
            scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        });

        const drive = google.drive({ version: "v3", auth });

        // 4. Lấy file mới nhất (Logic cũ: tin rằng file mới nhất là file cần xử lý)
        const list = await drive.files.list({
            q: `'${FOLDER_ID}' in parents and trashed = false and (mimeType contains 'video/' or mimeType contains 'image/')`,
            orderBy: "createdTime desc",
            pageSize: 1, 
            fields: "files(id,name,mimeType)",
        });

        const file = list.data.files?.[0];
        if (!file) {
            console.log("❓ Không tìm thấy file mới nào.");
            return;
        }

        const fileId = file.id;
        const fileName = file.name;
        const fileUrl = `https://drive.google.com/file/d/${fileId}/view`;
        console.log("📄 File mới:", fileName);

        // 5. Lock cứng bằng Firestore transaction (Quan trọng để ngăn xử lý trùng lặp)
        const processedRef = db.collection("processed_files").doc(fileId);
        try {
            await db.runTransaction(async (t) => {
                const snap = await t.get(processedRef);
                if (snap.exists) {
                    console.log("⏭️ File đã được xử lý (transaction locked):", fileId);
                    throw new Error("already processed");
                }
                t.set(processedRef, {
                    name: fileName,
                    processedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            });
        } catch (err) {
            if (err.message === "already processed") {
                return; 
            }
            throw err; 
        }

        // 6. Xử lý file theo tên (Logic gốc)
        const match = fileName.match(/^([A-Z0-9]+?)(B|P\d+)?\.(mp4|mkv|jpe?g|png)$/i);
        if (!match) {
            console.log("⛔ Không đúng định dạng:", fileName);
            return; 
        }

        const code = match[1];
        const suffix = match[2] || "";

        const snapshot = await db.collection("orders").where("code", "==", code).limit(1).get();
        if (snapshot.empty) {
            console.log("❓ Không tìm thấy đơn hàng:", code);
            return; 
        }

        const doc = snapshot.docs[0];
        const data = doc.data();
        const updates = {};
        const now = new Date();

        if (suffix === "B") {
            updates.videoStart = fileUrl;
        } else if (!suffix) {
            if (data.videoEnd === fileUrl) return; 

            updates.videoEnd = fileUrl;
            updates.status = "Completed";
            updates.completedAt = admin.firestore.Timestamp.fromDate(now);

            if (data.createdAt?.toDate) {
                const created = data.createdAt.toDate();
                const durationMinutes = Math.round((now - created) / (1000 * 60));
                updates.duration = durationMinutes;
            }

            await db.collection("notifications").add({
                message: `Đơn hàng ${code} đã hoàn thành.`,
                orderId: doc.id,
                partner: data.partner || "",
                readBy: [],
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
            });
        } else if (suffix.startsWith("P")) {
            const extra = data.extraVideos || [];
            if (extra.find(v => v.name === fileName)) return; 
            extra.push({ name: fileName, url: fileUrl });
            updates.extraVideos = extra;
        }

        await doc.ref.update(updates);
        console.log("✅ Đã cập nhật đơn:", code);
        return;

    } catch (error) {
        console.error("❌ Lỗi xử lý webhook:", error);
    }
});


// ✅ Khởi động server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook server chạy tại http://localhost:${PORT}`));