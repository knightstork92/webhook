const express = require("express");
const db = require("./firebase");
const admin = require("firebase-admin");
const app = express();
app.use(express.json());

/**
 * Webhook được gọi bởi Google Drive Push Notification khi có file mới.
 * Dựa trên tên file, xác định đơn hàng và cập nhật đúng trường.
 */
app.post("/drive-webhook", async (req, res) => {
  const { headers } = req;

  // 🪵 Log tất cả headers để kiểm tra xem webhook có được gọi không
  console.log("📩 Webhook được gọi, headers:", JSON.stringify(headers, null, 2));

  const fileId = headers["x-goog-resource-id"]; // ID nội bộ (not real fileId)
  const name = headers["x-goog-resource-uri"]?.split("/").pop(); // Trích tên file từ URL
  const resourceState = headers["x-goog-resource-state"]; // "update", "add", "delete"

  // 🪵 Log tên file & trạng thái resource
  console.log("📦 Tên file:", name);
  console.log("📍 Trạng thái:", resourceState);

  // Chỉ xử lý nếu là file mới hoặc thay đổi
  if (!name || !["update", "add"].includes(resourceState)) return res.sendStatus(200);

  const match = name.match(/^([A-Z0-9]+?)(B|P\d+)?\.(mp4|mkv|jpe?g|png)$/i);
  if (!match) {
    console.log("⛔ Không match định dạng file:", name);
    return res.sendStatus(200);
  }

  const code = match[1];
  const suffix = match[2] || "";

  try {
    const snapshot = await db.collection("orders")
      .where("code", "==", code)
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.log("❌ Không tìm thấy đơn hàng có mã:", code);
      return res.sendStatus(200);
    }

    const doc = snapshot.docs[0];
    const data = doc.data();
    const updates = {};
    const now = new Date();

    // Xử lý file bắt đầu ("B")
    if (suffix === "B") {
      updates.videoStart = `https://drive.google.com/file/d/${fileId}/view`;
      console.log(`✅ Gán videoStart cho đơn ${code}`);
    }

    // Xử lý file hoàn thành (không có hậu tố)
    else if (!suffix) {
      updates.videoEnd = `https://drive.google.com/file/d/${fileId}/view`;
      updates.status = "Completed";
      updates.completedAt = admin.firestore.Timestamp.fromDate(now);

      if (data.createdAt?.toDate) {
        const created = data.createdAt.toDate();
        const durationMinutes = Math.round((now - created) / (1000 * 60));
        updates.duration = durationMinutes;
        console.log(`⏱️ Duration: ${durationMinutes} phút`);
      }

      console.log(`✅ Gán videoEnd và đánh dấu Completed cho đơn ${code}`);

      await db.collection("notifications").add({
        message: `Đơn hàng ${code} đã hoàn thành.`,
        orderId: doc.id,
        partner: data.partner || "",
        readBy: [],
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`📢 Gửi thông báo hoàn thành đơn ${code}`);
    }

    // Xử lý file phụ ("P1", "P2", ...)
    else if (suffix.startsWith("P")) {
      const extra = data.extraVideos || [];
      const existing = extra.find(item => item.name === name);
      if (existing) {
        console.log("⚠️ File phụ đã tồn tại:", name);
        return res.status(200).send("File phụ đã tồn tại");
      }

      extra.push({ name, url: `https://drive.google.com/file/d/${fileId}/view` });
      updates.extraVideos = extra;
      console.log(`📎 Thêm file phụ ${name} vào đơn ${code}`);
    }

    await doc.ref.update(updates);
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Lỗi webhook xử lý đơn:", err);
    return res.status(500).send("Internal Error");
  }
});

// Server khởi động
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Webhook đang chạy tại cổng ${PORT}`));
