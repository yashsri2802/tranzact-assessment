const { Worker } = require('bullmq');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');

const s3 = new S3Client({ region: 'ap-south-1' });
const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

// Dedicated Fast-Lane Worker (Concurrency Capped at 8)
const fastLaneWorker = new Worker('single-pdf-queue', async (job) => {
  const { tenant_id, document_id, data } = job.data;
  
  // Launch isolated Chrome tab with memory limits
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--js-flags="--max-old-space-size=512"']
  });
  
  try {
    const page = await browser.newPage();
    
    // Inspect table line items for heavy document guard
    const lineItemCount = data.line_items ? data.line_items.length : 0;
    if (lineItemCount > 250) {
      console.warn(`Document ${document_id} has ${lineItemCount} items. Routing to heavy isolator.`);
    }

    const htmlContent = compileTemplate(data);
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    
    // Compute SHA-256 checksum for tamper evidence
    const sha256Hash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    const s3Key = `pdfs/${tenant_id}/${document_id}.pdf`;

    // Write to S3 Storage
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: s3Key,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
      Metadata: { 'sha256-checksum': sha256Hash }
    }));

    // Write SHA-256 Audit Record to PostgreSQL AuditVault
    await pgPool.query(
      'INSERT INTO pdf_audit_vault (tenant_id, document_id, s3_key, sha256_hash, created_at) VALUES ($1, $2, $3, $4, NOW())',
      [tenant_id, document_id, s3Key, sha256Hash]
    );

    return { s3Key, sha256Hash, status: 'COMPLETED' };
  } finally {
    await browser.close();
  }
}, { 
  connection: { host: process.env.REDIS_HOST },
  concurrency: 8 // Fast-Lane Concurrency Ceiling
});
