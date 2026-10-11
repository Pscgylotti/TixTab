import { readFile, writeFile } from 'node:fs/promises';
const file = new URL('../src/locales/en.json', import.meta.url),
  dictionary = JSON.parse(await readFile(file, 'utf8'));
Object.assign(dictionary, {
  本地模型管理: 'Local model library',
  '按需下载，离线运行': 'Download as needed, run offline',
  关闭模型管理: 'Close model library',
  '下载仅在确认后开始。打开此页不会加载模型；校验由你手动启动，避免后台耗电。':
    'Downloads start only after confirmation. Opening this page does not load models; integrity checks run only when requested.',
  '浏览器预览仅展示模型清单；下载与删除请使用桌面应用。':
    'Browser preview shows the catalog. Use the desktop app to download or remove models.',
  'AUTO 优先 NPU，再尝试 GPU 和 CPU；需要可选 OpenVINO 运行时。不兼容时回退 CPU。':
    'AUTO tries NPU, GPU, then CPU with the optional OpenVINO runtime. Unsupported acceleration falls back to CPU.',
  '无法读取模型状态。': 'Could not read model status.',
  '模型操作已完成。': 'Model operation completed.',
  '模型校验失败，未启用下载文件。':
    'Integrity check failed. Downloaded files have not been enabled.',
  '已有模型管理任务正在运行。': 'A model library task is already running.',
  '磁盘空间不足。': 'Not enough disk space.',
  '模型目录不可用，请检查是否包含符号链接。':
    'The model directory is unavailable. Check for symbolic links.',
  '模型操作失败，请检查网络与磁盘后重试。':
    'Model operation failed. Check the network and disk, then retry.',
  '正在校验…': 'Verifying…',
  '正在删除…': 'Removing…',
  '正在下载…': 'Downloading…',
  取消任务: 'Cancel task',
  '删除下载副本？': 'Remove downloaded copy?',
  '下载模型？': 'Download model?',
  '仅删除此模型的下载副本。内置权重和文档不受影响；没有内置权重时需重新下载才能离线使用。':
    'Remove only this downloaded model. Bundled weights and documents are preserved. Without bundled weights, offline use requires downloading it again.',
  '将从模型来源下载固定版本，并核对每个文件的 SHA256。':
    'Download the pinned version from its source and verify every file with SHA256.',
  确认下载: 'Confirm download',
  '读取状态…': 'Reading status…',
  未安装: 'Not installed',
  '已下载 · 离线可用': 'Downloaded · available offline',
  '内置 · 离线可用': 'Bundled · available offline',
  'SHA256 已校验': 'SHA256 verified',
  '朗读需同时安装 Piper phonemizer；完整离线包已内置。':
    'Speech also requires Piper phonemizer, included in the full offline build.',
  '模型仅在使用对应功能时加载。': 'Models load only when their feature is used.',
  下载: 'Download',
  校验文件: 'Verify files',
  删除下载副本: 'Remove download',
  '版本、许可与文件': 'Version, license and files',
  固定版本: 'Pinned version',
  许可说明: 'License information',
  运行设备: 'Execution devices',
  模型来源: 'Model source',
  '声音模型与训练数据条款以原始 MODEL_CARD 为准；Huayan 数据许可标注为 Unknown。':
    'Voice and dataset terms are specified in the original MODEL_CARD. Huayan lists its dataset license as Unknown.',
  '内置权重属于完整离线包，不能在应用中删除。轻量包只下载选定模型；旧版原生编译缓存不在这里删除。':
    'Bundled weights belong to the full offline build and cannot be removed here. The lite build downloads only selected models. Legacy native compilation caches are not removed here.',
  '本地模型尚未安装，请在设置的“本地模型管理”中按需下载。':
    'Local models are not installed. Download them in Settings → Local model library.',
  '文字 OCR': 'Text OCR',
  预览: 'Preview',
});
await writeFile(file, JSON.stringify(dictionary, null, 2) + '\n');
