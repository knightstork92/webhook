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
const PAGE_TOKEN_DOC = db.collection("config").doc("drivePageToken");
const FOLDER_ID = "1s8Puh7IA2zA-vttOBJmDmx3aXIuxUsJA"; 
const MIN_VALID_TOKEN = 100000; // Page Token thường là một số rất lớn, đặt ngưỡng an toàn.

// ✅ Hàm xử lý file mới (Logic đơn hàng của bạn)
async function processNewFile(drive, file, db, admin) {
    const fileId = file.id;
    const fileName = file.name;
    const fileUrl = `https://drive.google.com/file/d/${fileId}/view`;

    let code; 

    // ✅ Lock cứng bằng Firestore transaction để đảm bảo chỉ xử lý 1 lần
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

    // ✅ Xử lý file theo tên (Logic cũ của bạn)
    const match = fileName.match(/^([A-Z0-9]+?)(B|P\d+)?\.(mp4|mkv|jpe?g|png)$/i);
    if (!match) {
        console.log("⛔ Không đúng định dạng:", fileName);
        return; 
    }

    code = match[1];
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
}


// ✅ Webhook chính
app.post("/drive-webhook", async (req, res) => {
  const state = req.headers["x-goog-resource-state"];
  
  console.log("📩 Webhook được gọi:", JSON.stringify(req.headers, null, 2));
  console.log("📍 Trạng thái:", state);

  // 1. Phản hồi ngay lập tức (quan trọng cho webhook)
  res.sendStatus(204); 
  
  // 2. Lọc thông báo không liên quan
  if (state === "sync" || (state !== "change" && state !== "update" && state !== "add")) {
    console.log(`⏭️ Bỏ qua (Trạng thái: ${state})`);
    return;
  }

  try {
    // 3. Lấy PageToken được lưu trữ mới nhất từ Firestore
    const tokenSnap = await PAGE_TOKEN_DOC.get();
    let lastPageToken = tokenSnap.exists ? tokenSnap.data().token : null;
    let lastTokenNumber = 0; // Khởi tạo để so sánh

    // ⚠️ KIỂM TRA TÍNH HỢP LỆ CỦA TOKEN CŨ
    if (!lastPageToken || isNaN(lastPageToken)) {
        console.error("❌ LỖI NGHIÊM TRỌNG: lastPageToken không hợp lệ trong Firestore. Vui lòng khôi phục thủ công.");
        return; 
    }
    lastTokenNumber = parseInt(lastPageToken);
    
    // 4. Google Drive Auth
    const auth = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });

    const drive = google.drive({ version: "v3", auth });
    
    // 5. Lấy danh sách thay đổi (changes) kể từ token cuối cùng
    const response = await drive.changes.list({
        pageToken: lastPageToken,
        fields: 'newStartPageToken, changes(fileId, file/id, file/name, file/parents, file/mimeType, removed, kind)',
        pageSize: 100 
    });

    const newPageToken = response.data.newStartPageToken;
    const changes = response.data.changes || [];
    
    // 6. Lọc và xử lý từng thay đổi
    for (const change of changes) {
        if (change.removed || !change.file) continue;

        const file = change.file;
        const isAddedToFolder = file.parents && file.parents.includes(FOLDER_ID);
        const isMediaFile = file.mimeType && (file.mimeType.startsWith('video/') || file.mimeType.startsWith('image/'));
        
        if (isAddedToFolder && isMediaFile) {
            console.log(`🔎 Tìm thấy tệp mới cần xử lý: ${file.name} (ID: ${file.id})`);
            await processNewFile(drive, file, db, admin); 
        }
    }

    // 7. 🚨 LOGIC KIỂM TRA NGHIÊM NGẶT Page Token MỚI
    const newTokenNumber = parseInt(newPageToken);

    if (
        newPageToken &&                                 // Phải tồn tại
        !isNaN(newTokenNumber) &&                       // Phải là một số
        newTokenNumber > MIN_VALID_TOKEN &&             // Phải lớn hơn ngưỡng an toàn (tránh số nhỏ như '4')
        newTokenNumber > lastTokenNumber                // Phải lớn hơn token cũ đang dùng
    ) {
        await PAGE_TOKEN_DOC.set({ token: newPageToken });
        console.log(`✅ Đã cập nhật Page Token mới hợp lệ: ${newPageToken}`);
    } else {
        console.warn(`⚠️ Cảnh báo: Token mới (${newPageToken}) không hợp lệ hoặc nhỏ hơn token cũ (${lastPageToken}). KHÔNG CẬP NHẬT TOKEN. (Ngưỡng: ${MIN_VALID_TOKEN})`);
    }

  } catch (error) {
    console.error("❌ Lỗi xử lý webhook:", error);
  }
});


// ✅ Khởi động server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook server chạy tại http://localhost:${PORT}`));