const express = require("express");
const db = require("./firebase");
const admin = require("firebase-admin");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// 🧷 Khai báo trực tiếp folderId và serviceAccount tại đây
const FOLDER_ID = "1s8Puh7IA2zA-vttOBJmDmx3aXIuxUsJA"; // thay bằng folder ID thật
const SERVICE_ACCOUNT = require("./serviceAccountKey.json"); // để trong cùng thư mục

app.post("/drive-webhook", async (req, res) => {
  const state = req.headers["x-goog-resource-state"];
  const changed = req.headers["x-goog-changed"];

  console.log("📩 Webhook được gọi:", JSON.stringify(req.headers, null, 2));
  console.log("📍 Trạng thái:", state);
  console.log("🔄 Changed:", changed);

  if (state !== "update" || changed !== "children") {
    console.log("⏭️ Bỏ qua vì không phải thêm mới file");
    return res.sendStatus(200);
  }

  try {
    const auth = new google.auth.JWT({
      email: SERVICE_ACCOUNT.client_email,
      key: SERVICE_ACCOUNT.private_key,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"]
    });

    const drive = google.drive({ version: "v3", auth });

    // 🔍 Lấy file mới nhất (video hoặc ảnh)
    const list = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed = false and (mimeType contains 'video/' or mimeType contains 'image/')`,
      orderBy: "createdTime desc",
      pageSize: 1,
      fields: "files(id,name,mimeType,createdTime)"
    });

    const file = list.data.files?.[0];
    if (!file) return res.sendStatus(200);

    const fileId = file.id;
    const fileName = file.name;
    console.log("📄 File mới:", fileName);

    // 🔒 Check trùng
    const processed = await db.collection("processed_files").doc(fileId).get();
    if (processed.exists) {
      console.log("⏭️ File đã xử lý trước:", fileId);
      return res.sendStatus(200);
    }

    // ✅ Đánh dấu đã xử lý
    await db.collection("processed_files").doc(fileId).set({
      name: fileName,
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // ⛏ Tách mã đơn + hậu tố
    const match = fileName.match(/^([A-Z0-9]+?)(B|P\d+)?\.(mp4|mkv|jpe?g|png)$/i);
    if (!match) {
      console.log("⛔ Không match định dạng file:", fileName);
      return res.sendStatus(200);
    }

    const code = match[1];
    const suffix = match[2] || "";
    const snapshot = await db.collection("orders").where("code", "==", code).limit(1).get();

    if (snapshot.empty) {
      console.log("❓ Không tìm thấy đơn:", code);
      return res.sendStatus(200);
    }

    const doc = snapshot.docs[0];
    const data = doc.data();
    const updates = {};
    const now = new Date();
    const fileUrl = `https://drive.google.com/file/d/${fileId}/view`;

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
  } catch (err) {
    console.error("❌ Lỗi webhook:", err);
    return res.status(500).send("Internal Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Webhook đang chạy tại cổng ${PORT}`));
