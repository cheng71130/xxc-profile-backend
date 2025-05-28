const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

// 配置跨域
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 配置文件存储
const uploadDir = path.join(__dirname, 'uploads');
const chunksDir = path.join(__dirname, 'chunks');

// 确保目录存在
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}
if (!fs.existsSync(chunksDir)) {
  fs.mkdirSync(chunksDir);
}

// 先解析请求体，再使用multer
app.use(express.urlencoded({ extended: true }));

// 使用内存存储先接收文件
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 限制20MB
});

// 🆕 检查文件是否已存在（秒传功能）
app.post('/check-file', async (req, res) => {
  try {
    const { fileHash, fileName, size } = req.body;
    
    if (!fileHash || !fileName) {
      return res.status(400).json({
        code: 1,
        message: '缺少必要参数 fileHash 或 fileName'
      });
    }
    
    const filePath = path.join(uploadDir, fileName);
    
    // 检查文件是否存在
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      
      // 检查文件大小是否匹配
      if (size && stats.size === size) {
        return res.json({
          code: 0,
          exists: true,
          message: '文件已存在',
          file: {
            name: fileName,
            size: stats.size,
            createTime: stats.birthtime
          }
        });
      }
    }
    
    return res.json({
      code: 0,
      exists: false,
      message: '文件不存在'
    });
  } catch (error) {
    console.error('检查文件失败:', error);
    return res.status(500).json({
      code: 1,
      message: `检查文件失败: ${error.message}`
    });
  }
});

// 🆕 文件完整性校验
app.post('/verify', async (req, res) => {
  try {
    const { fileHash, fileName } = req.body;
    
    if (!fileHash || !fileName) {
      return res.status(400).json({
        code: 1,
        message: '缺少必要参数 fileHash 或 fileName'
      });
    }
    
    const filePath = path.join(uploadDir, fileName);
    
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        code: 1,
        message: '文件不存在',
        verified: false
      });
    }
    
    // 计算文件哈希进行校验
    const actualHash = await calculateFileHash(filePath);
    
    // 比较哈希值（去掉可能的前缀）
    const providedHash = fileHash.replace(/^temp-\d+-/, ''); // 移除临时前缀
    const verified = actualHash === providedHash || fileHash === actualHash;
    
    if (verified) {
      return res.json({
        code: 0,
        verified: true,
        message: '文件完整性校验通过'
      });
    } else {
      console.warn(`文件校验失败: 期望 ${providedHash}, 实际 ${actualHash}`);
      return res.json({
        code: 0,
        verified: false,
        message: '文件完整性校验失败',
        details: {
          expected: providedHash,
          actual: actualHash
        }
      });
    }
  } catch (error) {
    console.error('文件校验失败:', error);
    return res.status(500).json({
      code: 1,
      message: `文件校验失败: ${error.message}`,
      verified: false
    });
  }
});

// 🔧 计算文件哈希的辅助函数
async function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    
    stream.on('data', (data) => {
      hash.update(data);
    });
    
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
    
    stream.on('error', (error) => {
      reject(error);
    });
  });
}

// 处理分片上传
app.post('/upload', upload.single('chunk'), (req, res) => {
  try {
    const { hash, fileHash, filename } = req.body;
    
    // 检查必要参数
    if (!hash || !fileHash) {
      return res.status(400).json({
        code: 1,
        message: '缺少必要参数 hash 或 fileHash'
      });
    }
    
    // 确保分片目录存在
    const chunkDir = path.join(chunksDir, fileHash);
    if (!fs.existsSync(chunkDir)) {
      fs.mkdirSync(chunkDir, { recursive: true });
    }
    
    // 写入分片文件
    const chunkPath = path.join(chunkDir, hash);
    fs.writeFileSync(chunkPath, req.file.buffer);
    
    return res.json({
      code: 0,
      message: '分片上传成功'
    });
  } catch (error) {
    console.error('分片上传错误:', error);
    return res.status(500).json({
      code: 1,
      message: `分片上传失败: ${error.message}`
    });
  }
});

// 合并分片
app.post('/merge', async (req, res) => {
  try {
    const { fileHash, fileName, size } = req.body;
    
    if (!fileHash || !fileName) {
      return res.status(400).json({
        code: 1,
        message: '缺少必要参数 fileHash 或 fileName'
      });
    }
    
    const chunkDir = path.join(chunksDir, fileHash);
    const filePath = path.join(uploadDir, fileName);
    
    // 检查分片目录是否存在
    if (!fs.existsSync(chunkDir)) {
      return res.status(400).json({
        code: 1,
        message: '没有找到相关分片'
      });
    }
    
    // 获取所有分片
    let chunks = await fs.promises.readdir(chunkDir);
    
    if (chunks.length === 0) {
      return res.status(400).json({
        code: 1,
        message: '没有找到任何分片文件'
      });
    }
    
    // 按索引排序
    chunks = chunks.sort((a, b) => {
      const indexA = a.split('-')[0]; // 修改：使用第一个部分作为索引
      const indexB = b.split('-')[0];
      return parseInt(indexA) - parseInt(indexB);
    });
    
    // 创建写入流
    const writeStream = fs.createWriteStream(filePath);
    
    // 逐个合并分片
    for (const chunk of chunks) {
      const chunkPath = path.join(chunkDir, chunk);
      const buffer = await fs.promises.readFile(chunkPath);
      writeStream.write(buffer);
      
      // 删除已合并的分片
      await fs.promises.unlink(chunkPath);
    }
    
    writeStream.end();
    
    // 删除分片目录
    setTimeout(() => {
      fs.promises.rmdir(chunkDir)
        .catch(err => console.error('删除分片目录失败:', err));
    }, 1000);
    
    return res.json({
      code: 0,
      message: '文件合并成功',
      url: `/uploads/${fileName}`
    });
  } catch (error) {
    console.error('合并文件错误:', error);
    return res.status(500).json({
      code: 1,
      message: `文件合并失败: ${error.message}`
    });
  }
});

// 获取已上传文件列表
app.get('/files', async (req, res) => {
  try {
    const files = await fs.promises.readdir(uploadDir);
    const fileList = files.map(file => {
      const stats = fs.statSync(path.join(uploadDir, file));
      return {
        name: file,
        size: stats.size,
        createTime: stats.birthtime
      };
    });
    
    return res.json({
      code: 0,
      data: fileList
    });
  } catch (error) {
    return res.status(500).json({
      code: 1,
      message: `获取文件列表失败: ${error.message}`
    });
  }
});

// 静态文件服务
app.use('/uploads', express.static(uploadDir));

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器已启动，监听端口: ${PORT}`);
  console.log(`上传目录: ${uploadDir}`);
  console.log(`分片目录: ${chunksDir}`);
  console.log(`新增功能: 秒传检查 (/check-file) 和 文件校验 (/verify)`);
});