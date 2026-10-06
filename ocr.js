(() => {
  const fileInput = document.querySelector('#photo');
  const drop = document.querySelector('.drop');
  const status = document.querySelector('#status');
  const raw = document.querySelector('#raw');
  const preview = document.querySelector('#preview');
  const previewImg = document.querySelector('#previewImg');
  const fileName = document.querySelector('#fileName');
  const button = document.querySelector('#recognize');
  const cameraPane = document.querySelector('#cameraPane');
  const cameraView = document.querySelector('#cameraView');
  let selectedFile = null;
  let previewUrl = null;
  let busy = false;
  let cameraStream = null;

  function report(message) { status.textContent = message; }
  function parseLine(line) {
    const cleaned = line.replace(/[，,|｜]/g, ' ').replace(/[￥¥]/g, '').replace(/\s+/g, ' ').trim();
    if (!cleaned || /^(采购|商品|名称|数量|单位|单价|金额|合计|总计|日期|供应商|电话|备注|序号)/.test(cleaned)) return null;
    const match = cleaned.match(/^(?:\d+[.、\s]+)?(.+?)\s+(\d+(?:\.\d+)?)\s*([\u4e00-\u9fa5]{1,3}|kg|KG|L|g)?\s+(\d+(?:\.\d+)?)(?:\s+\d+(?:\.\d+)?)?$/);
    if (!match) return null;
    let name = match[1].replace(/\s+/g, '').replace(/^\d{5,}/, '').replace(/^[^\u4e00-\u9fa5A-Za-z]+/, '').trim();
    if (!/[^\d.\s]/.test(name)) return null;
    let unit = match[3] || '';
    if (!unit && /(?:件|箱|斤|袋|包|盒|瓶|桶|个|只|条)$/.test(name)) {
      unit = name.slice(-1);
      name = name.slice(0, -1);
    }
    return { name, qty: Number(match[2]), unit, price: Number(match[4]), cat: category(name) };
  }
  function build(text) {
    const parsed = text.split(/\r?\n/).map(parseLine).filter(Boolean);
    if (!parsed.length) { report('已取得文字，请检查单据文字并手动调整后再生成草稿'); toast('未找到可确认的商品行'); return; }
    rows.replaceChildren();
    parsed.forEach(makeRow);
    show();
    const missed = text.split(/\r?\n/).filter(line => line.trim() && !parseLine(line) && !/^(采购|商品|名称|数量|单位|单价|金额|合计|总计|日期|供应商|电话|备注|序号)/.test(line.trim())).length;
    const unusual = parsed.filter(item => !/^(公斤|千克|kg|KG|斤|箱|件|袋|包|盒|瓶|桶|个|只|条|把|筐|提|盘|板|支|升|L|克|g)$/.test(item.unit));
    if (missed || unusual.length) {
      const warning = document.querySelector('#warning');
      warning.style.display = 'block';
      warning.textContent = `${missed ? `另有 ${missed} 行未能可靠解析。` : ''}${unusual.length ? `请核对 ${unusual.map(item => item.name).join('、')} 的单位。` : ''}请对照左侧原文核对草稿。`;
    }
  }
  async function recognizeNameColumn(file, worker) {
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width / bitmap.height < 2.2) return [];
      const left = Math.round(bitmap.width * 0.095);
      const width = Math.round(bitmap.width * 0.225);
      const scale = 3;
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = bitmap.height * scale;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, left, 0, width, bitmap.height, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < pixels.data.length; i += 4) {
        const gray = (pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2]) / 3;
        const value = gray < 165 ? 0 : 255;
        pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value;
      }
      context.putImageData(pixels, 0, 0);
      const result = await worker.recognize(canvas);
      return result.data.text.split(/\r?\n/).map(line => line.replace(/[\s\d。、”"'‘’`~!@#$%^&*()_+={}\[\]|\\:;<>?\/]/g, '').trim()).filter(Boolean);
    } finally { bitmap.close(); }
  }
  async function recognizePriceColumn(file, worker) {
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width / bitmap.height < 2.2) return [];
      const left = Math.round(bitmap.width * 0.8);
      const width = Math.round(bitmap.width * 0.16);
      const scale = 3;
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = bitmap.height * scale;
      canvas.getContext('2d').drawImage(bitmap, left, 0, width, bitmap.height, 0, 0, canvas.width, canvas.height);
      await worker.setParameters({ tessedit_char_whitelist: '0123456789.', tessedit_pageseg_mode: '6' });
      const result = await worker.recognize(canvas);
      await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' });
      return result.data.text.split(/\r?\n/).map(line => line.trim()).filter(line => /^\d+(?:\.\d+)?$/.test(line)).map(Number);
    } finally { bitmap.close(); }
  }
  async function recognizePhoto(file) {
    if (busy) return;
    if (!window.Tesseract) { report('识别组件加载失败；请检查网络后刷新页面'); toast('识别组件未加载'); return; }
    busy = true;
    button.disabled = true;
    button.textContent = '正在识别照片…';
    let worker;
    try {
      report('正在加载中文识别模型，首次使用可能需要稍候…');
      worker = await Tesseract.createWorker('chi_sim+eng', 1, {
        workerPath: new URL('vendor/worker.min.js', location.href).href,
        corePath: new URL('vendor/core/tesseract-core-lstm.wasm.js', location.href).href,
        langPath: new URL('vendor/lang/', location.href).href,
        logger: message => {
          if (message.status === 'recognizing text') report(`正在识别照片… ${Math.round((message.progress || 0) * 100)}%`);
        }
      });
      const result = await worker.recognize(file);
      const text = (result.data.text || '').trim();
      if (!text) { report('未识别出文字，请拍清晰一些或手动输入单据文字'); return; }
      raw.value = text;
      const parsed = text.split(/\r?\n/).map(parseLine).filter(Boolean);
      let columnNames = [];
      if (parsed.length && parsed.length <= 50) {
        report('正在核对商品名称列…');
        columnNames = await recognizeNameColumn(file, worker);
      }
      console.info('Name-column OCR:', columnNames.join(' / '));
      if (columnNames.length === parsed.length) {
        parsed.forEach((item, index) => {
          const candidate = columnNames[index];
          if ((item.name.match(/[\u4e00-\u9fa5]/g) || []).length < 2 && (candidate.match(/[\u4e00-\u9fa5]/g) || []).length >= 2) {
            item.name = candidate;
            item.cat = category(candidate);
          }
        });
      }
      parsed.forEach((item, index) => {
        if ((item.name.match(/[\u4e00-\u9fa5]/g) || []).length < 2) {
          item.name = `第${index + 1}行名称待核对`;
          item.cat = '待确认';
        }
      });
      const columnPrices = parsed.length && parsed.length <= 50 ? await recognizePriceColumn(file, worker) : [];
      console.info('Price-column OCR:', columnPrices.join(' / '));
      if (columnPrices.length === parsed.length) parsed.forEach((item, index) => { item.price = columnPrices[index]; });
      if (parsed.length) {
        rows.replaceChildren();
        parsed.forEach(makeRow);
        show();
        const uncertain = parsed.filter(item => (item.name.match(/[\u4e00-\u9fa5]/g) || []).length < 2);
        if (uncertain.length || columnNames.length !== parsed.length || columnPrices.length !== parsed.length) {
          const warning = document.querySelector('#warning');
          warning.style.display = 'block';
          warning.textContent = `请核对照片：${uncertain.length} 行商品名称未可靠识别；${columnPrices.length !== parsed.length ? '价格列未能完整复核；' : ''}空白单位请按原单补充。`;
        }
      } else build(text);
    } catch (error) {
      console.error('OCR failed', error);
      report('照片识别失败，请检查网络或改用清晰照片');
      toast('照片识别失败，可手动输入单据文字');
    } finally {
      if (worker) await worker.terminate();
      busy = false;
      button.disabled = false;
      button.textContent = '识别并生成入库草稿';
    }
  }
  async function selectFile(file) {
    if (!file) return;
    if (/\.xlsx$/i.test(file.name)) {
      if (!window.XLSX) { report('Excel 读取组件加载失败'); return; }
      try {
        const workbook = XLSX.read(await file.arrayBuffer());
        const sections = workbook.SheetNames.map(name => {
          const grid = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' });
          return [`[工作表] ${name}`, ...grid.map(row => row.map(cell => String(cell).trim()).join('\t'))].join('\n');
        });
        raw.value = sections.join('\n');
        fileName.textContent = file.name;
        preview.style.display = 'none';
        report(`已读取 Excel：${workbook.SheetNames.length} 个工作表`);
        return;
      } catch (error) { console.error('Excel import failed', error); report('Excel 读取失败，请检查文件是否损坏'); return; }
    }
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { toast('请选择 JPG、PNG、WebP 或 XLSX 文件'); return; }
    selectedFile = file;
    fileName.textContent = file.name;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    previewImg.src = previewUrl;
    preview.style.display = 'block';
    recognizePhoto(file);
  }
  fileInput.onchange = event => selectFile(event.target.files[0]);
  document.querySelector('#cameraFile').onchange = event => selectFile(event.target.files[0]);
  document.querySelector('#cameraStart').onclick = async () => {
    if (!navigator.mediaDevices?.getUserMedia) { toast('当前浏览器不支持摄像头，请改用照片文件'); return; }
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      cameraView.srcObject = cameraStream;
      cameraPane.hidden = false;
      report('请将单据放在镜头内，保持清晰后点击“拍下单据”');
    } catch (error) { console.error('Camera unavailable', error); toast('无法打开摄像头，请检查浏览器权限'); }
  };
  document.querySelector('#cameraClose').onclick = () => {
    cameraStream?.getTracks().forEach(track => track.stop());
    cameraStream = null;
    cameraView.srcObject = null;
    cameraPane.hidden = true;
  };
  document.querySelector('#cameraTake').onclick = () => {
    if (!cameraStream || !cameraView.videoWidth) { toast('摄像头尚未准备好'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = cameraView.videoWidth;
    canvas.height = cameraView.videoHeight;
    canvas.getContext('2d').drawImage(cameraView, 0, 0);
    canvas.toBlob(blob => {
      document.querySelector('#cameraClose').click();
      if (blob) selectFile(new File([blob], `单据照片_${Date.now()}.png`, { type: 'image/png' }));
    }, 'image/png');
  };
  for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, event => { event.preventDefault(); drop.style.borderColor = '#3ec0a0'; });
  for (const name of ['dragleave', 'drop']) drop.addEventListener(name, event => { event.preventDefault(); drop.style.borderColor = ''; });
  drop.addEventListener('drop', event => selectFile(event.dataTransfer.files[0]));
  button.onclick = () => {
    if (busy) return;
    const text = raw.value.trim();
    if (text) build(text);
    else if (selectedFile) recognizePhoto(selectedFile);
    else toast('请先选择照片、输入单据文字或填入示例');
  };
  if (document.modelContext?.registerTool) {
    try {
      Promise.resolve(document.modelContext.registerTool({
        name: 'stage_receipt_lines',
        title: '生成入库草稿',
        description: '将已读取的商品行放入待核对的入库草稿，不提交到二维火。',
        inputSchema: {
          type: 'object',
          properties: {
            lines: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: {
              name: { type: 'string' }, quantity: { type: 'number' }, unit: { type: 'string' }, unitPrice: { type: 'number' }
            }, required: ['name', 'quantity', 'unit', 'unitPrice'], additionalProperties: false } }
          }, required: ['lines'], additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute(input) {
          if (!Array.isArray(input?.lines) || !input.lines.length || input.lines.length > 100) throw new Error('商品行数无效');
          const entries = input.lines.map(line => {
            if (typeof line.name !== 'string' || !line.name.trim() || typeof line.unit !== 'string' || !Number.isFinite(line.quantity) || line.quantity <= 0 || !Number.isFinite(line.unitPrice) || line.unitPrice < 0) throw new Error('商品行内容无效');
            return { name: line.name.trim(), qty: line.quantity, unit: line.unit.trim() || '件', price: line.unitPrice, cat: category(line.name) };
          });
          rows.replaceChildren();
          entries.forEach(makeRow);
          show();
          return { staged: entries.length, needsReview: true };
        }
      })).catch(error => console.warn('WebMCP registration failed', error));
    } catch (error) { console.warn('WebMCP unavailable', error); }
  }
})();
