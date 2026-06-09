const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

async function extractText(buffer, mimetype, originalname) {
  const ext = (originalname || '').toLowerCase().split('.').pop();

  if (mimetype === 'application/pdf' || ext === 'pdf') {
    const data = await pdfParse(buffer);
    return data.text.trim();
  }

  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim();
  }

  if (mimetype === 'application/msword' || ext === 'doc') {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim();
    } catch {
      throw new Error('.doc format not fully supported — please convert to .docx or PDF.');
    }
  }

  // Plain text fallback
  return buffer.toString('utf-8').trim();
}

module.exports = { extractText };
