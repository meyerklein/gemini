// server.js
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3005;

// Use Helmet to set security headers
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "font-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
    },
  })
);

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Set up multer for memory storage to handle file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Helper: recursive collector to find text-like fields in Gemini response
function collectTextPieces(obj, out = []) {
  if (!obj) return out;
  if (typeof obj === 'string') {
    out.push(obj);
    return out;
  }
  if (Array.isArray(obj)) {
    for (const el of obj) collectTextPieces(el, out);
    return out;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      // typical text containers: text, content, output, message, parts[*].text, etc.
      if ((/text|content|message|output/i).test(k) && typeof v === 'string') {
        out.push(v);
      }
      collectTextPieces(v, out);
    }
  }
  return out;
}

// API endpoint to process the PDF
app.post('/process-pdf', upload.single('bankStatement'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file uploaded.' });
  }

  try {
    const pdfBuffer = req.file.buffer;
    const pdfBase64 = pdfBuffer.toString('base64');

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set in .env' });

    // allow override from env
    const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS || '65535', 10);

    const payload = {
      contents: [{
        parts: [
          { text: "Extract structured data from this PDF according to the provided schema." },
          { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
          { text: JSON.stringify({
              "instructions": "Extract the following fields only if present in the document. Ensure you process all pages of the document to extract all transactions. If a field is missing, return an empty string or null. Do not invent data. Represent withdrawals as negative amounts.",
              "schema": {
                "statement_info": {
                  "billing_start_cycle": "mm/dd/yyyy",
                  "billing_end_cycle": "mm/dd/yyyy",
                  "account_holder_name": "",
                  "account_number": "",
                  "account_holder_address": "",
                  "bank_name": ""
                },
                "account_summary": {
                  "total_withdrawals": "",
                  "total_deposits": ""
                },
                "transactions": [{
                  "date": "",
                  "amount": "",
                  "description": "",
                  "daily_balance": "",
                  "transaction_id": ""
                }]
              }
            }) }
        ]
      }],
      generationConfig: {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.1,
        responseMimeType: "application/json"
      }
    };

    // axios with extended timeout for large document processing
    const axiosConfig = {
      headers: { 'Content-Type': 'application/json' },
      timeout: parseInt(process.env.AXIOS_TIMEOUT_MS || '220000', 10) // default 120s
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await axios.post(url, payload, axiosConfig);

    // quick debug: show keys & small preview
    console.log('--- GEMINI RESPONSE KEYS ---', Object.keys(response.data || {}));
    console.log('--- RESPONSE PREVIEW (first 40k chars) ---\n', JSON.stringify(response.data || {}).slice(0, 40000));

    const candidate = response.data?.candidates?.[0];
    if (!candidate) {
      console.error('No candidate returned from Gemini:', response.data);
      return res.status(500).json({ error: 'No candidate returned from Gemini', rawResponse: response.data });
    }

    // collect text pieces from candidate and top-level response
    const textPieces = collectTextPieces(candidate, []);
    collectTextPieces(response.data, textPieces);

    const joinedText = textPieces.join('\n').trim();
    console.log('--- EXTRACTOR: text pieces collected =', textPieces.length);
    console.log('--- EXTRACTOR: joinedText length (chars) =', joinedText.length);

    // usage metadata for diagnostics (may help detect token truncation)
    const usage = response.data?.usageMetadata || response.data?.usage || null;
    console.log('--- GEMINI: usageMetadata =', usage ?? 'no usage metadata found');

    // Attempt to parse JSON; fallback to heuristics if needed
    try {
      const extractedJSON = JSON.parse(joinedText);
      return res.json(extractedJSON);
    } catch (parseErr) {
      console.warn('Primary JSON.parse failed:', parseErr.message);

      // Heuristic salvage 1: largest substring between first '{' and last '}'
      const firstBrace = joinedText.indexOf('{');
      const lastBrace = joinedText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const candidateJson = joinedText.slice(firstBrace, lastBrace + 1);
        try {
          const extractedJSON = JSON.parse(candidateJson);
          console.log('Salvage parse succeeded (brace heuristic).');
          return res.json(extractedJSON);
        } catch (braceErr) {
          console.warn('Brace-salvage parse failed:', braceErr.message);
        }
      }

      // Heuristic salvage 2: trim to last closing brace and attempt parse
      const lastClose = joinedText.lastIndexOf('}');
      if (lastClose > 0) {
        const salvage = joinedText.slice(0, lastClose + 1);
        try {
          const extractedJSON = JSON.parse(salvage);
          console.log('Salvage parse succeeded (last-close heuristic).');
          return res.json(extractedJSON);
        } catch (salvageErr) {
          console.warn('Last-close-salvage parse also failed:', salvageErr.message);
        }
      }

      // final fallback: return helpful debug object
      return res.status(500).json({
        error: 'Failed to parse JSON from Gemini response',
        message: parseErr.message,
        rawPreview: joinedText.slice(0, 32000),
        piecesCollected: textPieces.length,
        usageMetadata: usage ?? null,
        candidatePreview: JSON.stringify(candidate).slice(0, 32000)
      });
    }

  } catch (error) {
    console.error('Error processing PDF with Gemini:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to process PDF with Gemini AI.',
      detail: error.response?.data ?? error.message
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
