const express = require("express");
const admin = require("firebase-admin");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// ✅ Đọc key từ biến môi trường base64
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf8")
);

// ✅ Khởi tạo Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const FOLDER_ID = "1s8Puh7IA2zA-vttOBJmDmx3aXIuxUsJA";

// ✅ Webhook chính
app.post("/drive-webhook", async (req, res) => {
  const state = req.headers["x-goog-resource-state"];
  const changed = req.headers["x-goog-changed"];

  console.log("📩 Webhook được gọi:", JSON.stringify(req.headers, null, 2));
  console.log("📍 Trạng thái:", state);
  console.log("🔄 Changed:", changed);

  if (state !== "update" || changed !== "children") {
    console.log("⏭️ Không phải sự kiện thêm file");
    return res.sendStatus(200);
  }

  try {
    // ✅ Google Drive Auth
    const auth = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });

    const drive = google.drive({ version: "v3", auth });

    // ✅ Lấy file mới nhất
    const list = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed = false and (mimeType contains 'video/' or mimeType contains 'image/')`,
      orderBy: "createdTime desc",
      pageSize: 1,
      fields: "files(id,name,mimeType)",
    });

    const file = list.data.files?.[0];
    if (!file) return res.sendStatus(200);

    const fileId = file.id;
    const fileName = file.name;
    const fileUrl = `https://drive.google.com/file/d/${fileId}/view`;
    console.log("📄 File mới:", fileName);

    // ✅ Lock cứng bằng Firestore transaction
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
        return res.sendStatus(200); // bỏ qua hợp lệ
      }
      throw err; // lỗi khác thì ném ra ngoài
    }

    // ✅ Xử lý file theo tên
    const match = fileName.match(/^([A-Z0-9]+?)(B|P\d+)?\.(mp4|mkv|jpe?g|png)$/i);
    if (!match) {
      console.log("⛔ Không đúng định dạng:", fileName);
      return res.sendStatus(200);
    }

    const code = match[1];
    const suffix = match[2] || "";

    const snapshot = await db.collection("orders").where("code", "==", code).limit(1).get();
    if (snapshot.empty) {
      console.log("❓ Không tìm thấy đơn hàng:", code);
      return res.sendStatus(200);
    }

    const doc = snapshot.docs[0];
    const data = doc.data();
    const updates = {};
    const now = new Date();

    if (suffix === "B") {
      updates.videoStart = fileUrl;
    } else if (!suffix) {
      if (data.videoEnd === fileUrl) return res.sendStatus(200);

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
      if (extra.find(v => v.name === fileName)) return res.sendStatus(200);
      extra.push({ name: fileName, url: fileUrl });
      updates.extraVideos = extra;
    }

    await doc.ref.update(updates);
    console.log("✅ Đã cập nhật đơn:", code);
    return res.sendStatus(200);
  } catch (error) {
    console.error("❌ Lỗi xử lý webhook:", error);
    return res.status(500).send("Internal Server Error");
  }
});

// ✅ Khởi động server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server chạy tại http://localhost:${PORT}`));
