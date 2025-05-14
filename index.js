const express = require("express");
const db = require("./firebase");
const admin = require("firebase-admin");
const { google } = require("googleapis"); // ✅ Dùng từ googleapis
const app = express();
app.use(express.json());

app.post("/drive-webhook", async (req, res) => {
  const folderId = req.headers["x-goog-resource-uri"]?.split("/").pop()?.split("?")[0];
  const state = req.headers["x-goog-resource-state"];
  const changed = req.headers["x-goog-changed"];

  console.log("📩 Webhook được gọi:", JSON.stringify(req.headers, null, 2));
  console.log("📁 Folder ID:", folderId);
  console.log("📍 Trạng thái:", state);
  console.log("🔄 Changed:", changed);

  if (state !== "update" || changed !== "children") {
    console.log("⏭️ Bỏ qua vì không phải thêm mới file");
    return res.sendStatus(200);
  }

  try {
    // ✅ Dùng GoogleAuth đúng từ google.auth
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });

    const authClient = await auth.getClient();
    const drive = google.drive({ version: "v3", auth: authClient });

    const list = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      orderBy: "createdTime desc",
      pageSize: 1,
      fields: "files(id,name,mimeType)"
    });

    const file = list.data.files?.[0];
    if (!file) return res.sendStatus(200);

    const fileId = file.id;
    const fileName = file.name;
    console.log("📄 File mới:", fileName);

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

    if (suffix === "B") {
      updates.videoStart = `https://drive.google.com/file/d/${fileId}/view`;
    } else if (!suffix) {
      updates.videoEnd = `https://drive.google.com/file/d/${fileId}/view`;
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
      extra.push({ name: fileName, url: `https://drive.google.com/file/d/${fileId}/view` });
      updates.extraVideos = extra;
    }

    await doc.ref.update(updates);
    console.log("✅ Đã cập nhật đơn:", code);
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Lỗi webhook xử lý đơn:", err);
    return res.status(500).send("Internal Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Webhook đang chạy tại cổng ${PORT}`));
