// server.js

const express = require('express');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const app = express();
const port = 3007;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Set up multer for memory storage to handle file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// API endpoint to process the PDF
app.post('/process-pdf', upload.single('bankStatement'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    try {
        const pdfBuffer = req.file.buffer;
        const pdfBase64 = pdfBuffer.toString('base64');

        const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
        const MODEL = 'gemini-1.5-flash'; // Updated model name

        const payload = {
            contents: [{
                parts: [
                    {
                        text: "Extract structured data from this PDF according to the provided schema."
                    },
                    {
                        inline_data: {
                            mime_type: "application/pdf",
                            data: pdfBase64
                        }
                    },
                    {
                        text: JSON.stringify({
                            "instructions": "Extract the following fields only if present in the document. If a field is missing, return an empty string or null. Do not generate or assume any additional data. Ensure amounts for withdrawals are negative numbers.",
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
                                "transactions": [
                                    {
                                        "date": "",
                                        "amount": "", // Use negative numbers for withdrawals
                                        "description": "",
                                        "daily_balance": "",
                                        "transaction_id": ""
                                    }
                                ]
                            }
                        })
                    }
                ]
            }],
            generationConfig: {
                maxOutputTokens: 8192,
                temperature: 0.1,
                responseMimeType: "application/json",
            }
        };

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
            payload,
            {
                headers: { 'Content-Type': 'application/json' }
            }
        );

        const textContent = response.data.candidates[0].content.parts[0].text;
        const extractedJSON = JSON.parse(textContent);
        
        res.json(extractedJSON);

    } catch (error) {
        console.error('Error processing PDF with Gemini:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to process PDF with Gemini AI.' });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});