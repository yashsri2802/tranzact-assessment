
# Approach Document: PDF Generation Microservice

## 1. Initial Understanding
When I first read the problem statement, I recognized that this is a high-concurrency background processing problem disguised as a document generation task. Converting HTML templates to PDFs using headless browser automation (Puppeteer) is notoriously CPU- and memory-heavy.

Before using AI or doing deep architectural research, my initial intuition flagged three major technical bottlenecks:
1. **Memory Spikes & Worker Crashes:** Headless Chromium instances temporarily consume ~400 MB of RAM per render. Unbounded parallel processing will quickly exhaust system RAM and crash the server node via Out-Of-Memory (OOM) kernel panics.
2. **Head-of-Line Blocking for Single Downloads:** If a single PDF request gets stuck behind a bulk job generating 100 PDFs, the single request will easily exceed the 5-second SLA target.
3. **Data Drift in Bulk Workflows:** Generating 100 PDFs sequentially takes 3–5 minutes. If primary ERP entities (such as GST tax rates or invoice amounts) are modified mid-job, earlier invoices will reflect different state than later ones.

---

## 2. Assumptions & Clarifying Questions

### Assumptions Made
1. **AWS S3 Availability:** Object storage (AWS S3 or an equivalent S3-compatible service) is available for storing snapshots, generated PDFs, and ZIP archives.
2. **Upstream Authorization:** Authentication, tenant isolation verification, and input validation are handled by the primary Django monolith before dispatching job payloads to the PDF service.
3. **Template Engine:** Handlebars/Jinja HTML templates are pre-compiled and cached in the Node.js service memory to minimize disk I/O overhead during renders.
4. **Co-located VPC Infrastructure:** The new PDF microservice will run in the same AWS Region and VPC as the existing EC2 instance, Redis cache, and RDS database to keep internal transit latency under 5ms.

### Clarifying Questions for Engineering Lead / Product Team
1. **Burst SLA vs. Graceful Queueing:** During sudden single-request spikes (~1,000 req/min), should the service shed load with an HTTP `429 Too Many Requests` status, or is brief queue buffering acceptable to protect server RAM?
2. **Compliance Retention Policy:** How long must generated PDFs remain stored in S3 before being moved to AWS Glacier or permanently deleted via lifecycle rules?
3. **Peak Spike Distribution:** Are the ~1,000 single requests/minute distributed evenly or concentrated in multi-second bursts?

---

## 3. Capacity Planning & Math

### 1. Theoretical Peak Demand Sizing
* **Single Request Peak Rate:** $\frac{1,000 \text{ requests}}{60 \text{ seconds}} \approx 16.67 \text{ req/sec}$
* **Bulk Request Peak Rate:** $\frac{10 \text{ bulk requests} \times 100 \text{ PDFs}}{60 \text{ seconds}} = 1,000 \text{ PDFs/min} \approx 16.67 \text{ PDFs/sec}$
* **Combined Peak Demand:** $\sim 33.34 \text{ PDFs/sec}$
* **Average Render Duration:** $2.5 \text{ seconds per PDF}$

Using **Little's Law** ($\text{Concurrency} = \text{Arrival Rate} \times \text{Latency}$):
$$\text{Theoretical Peak Concurrency} = 33.34 \text{ PDFs/sec} \times 2.5 \text{ sec} = 83.35 \approx 84 \text{ concurrent Chromium tabs}$$

* **Peak RAM Consumption at Unconstrained Capacity:**
  $$84 \text{ workers} \times 400 \text{ MB RAM} = 33,600 \text{ MB} \approx 33.6 \text{ GB RAM}$$

### 2. Ambiguity & Budget Contradiction Analysis
Running an AWS setup with 33.6 GB dedicated RAM and 42 vCPU cores 24/7 costs upwards of **$300–$400/month**, which directly violates the **₹12,500 (~$150 USD)** monthly budget constraint. Furthermore, processing 2,000 PDFs per minute would reach the customer's full monthly volume quota of 30,000 PDFs in just **15 minutes**.

This proves mathematically that 1,000 req/min is a short-duration burst rate rather than sustained daily load.

### 3. Provisioned Concurrency Sizing (EC2 `t4g.xlarge` - 16 GB RAM)
To remain strictly within budget, we provision a dedicated worker node (EC2 `t4g.xlarge` with 4 vCPUs / 16 GB RAM) and cap worker pools:

* **Fast-Lane Workers (Single Queue):** Initial concurrency cap = 8
* **Batch-Lane Workers (Bulk Queue):** Initial concurrency cap = 4
* **Heavy-Document Isolator (500+ Items):** Concurrency cap = 1–2
* **Total Active Rendering Slots:** 12 to 14 workers maximum.
* **Rendering Baseline Memory:** $12 \times 400 \text{ MB} = 4,800 \text{ MB} = 4.8 \text{ GB RAM}$.
* **System Headroom:** Adding ~3.0 GB for Chromium overhead, ~2.0 GB for OS/Node.js, and ~3.0 GB for buffer allocation keeps peak node usage under **12.8 GB** (safely within 16 GB capacity).

*Note: These concurrency limits are provisional baselines subject to load testing.*

---

## 4. Design Decisions

### Decision 1: Dedicated Dual-Queue Isolation using Existing Redis (BullMQ)
* **Alternatives Considered:** 
  1. Synchronous inline HTTP rendering inside the Django monolith.
  2. AWS SQS + AWS Lambda serverless execution.
  3. Node.js microservice using BullMQ backed by existing Redis.
* **Chosen Approach:** **Node.js microservice with BullMQ on existing Redis.**
* **Why:** Synchronous rendering in Django blocks web worker threads and triggers gateway timeouts. AWS Lambda introduces unpredictable billing and cold starts (>5s) that violate the single download SLA. Reusing the existing Redis cluster with BullMQ adds zero infrastructure base cost while providing native priority queues (`single-pdf-queue` vs. `bulk-pdf-queue`).
* **Trade-Off Accepted:** Introduces a secondary Node.js worker service to maintain alongside Django.

---

### Decision 2: Point-in-Time Payload Snapshotting to AWS S3
* **Alternatives Considered:** 
  1. Live RDS database reads during background execution.
  2. Passing large raw JSON arrays inside Redis queue payloads.
  3. Writing an immutable JSON snapshot object to S3 at job creation.
* **Chosen Approach:** **Point-in-Time Payload Snapshotting to S3.**
* **Why:** Querying RDS dynamically during a 3-minute bulk run causes stale data if database entities change mid-job. Passing massive JSON strings in Redis bloats cache memory. Django serializes all document records at trigger time, writes `/snapshots/{job_id}.json` to S3, and passes only the key to the queue. Workers read from this immutable snapshot, guaranteeing zero data drift across all 100 generated PDFs.
* **Trade-Off Accepted:** Adds a small S3 write latency (~50ms) during initial job creation.

---

### Decision 3: Heavy-Document Isolation Lane for 500+ Line Items
* **Alternatives Considered:** 
  1. Splitting invoices across multiple PDF files.
  2. Standard processing with standard worker retries.
  3. Pre-render line-item counting with routing to an isolated Heavy-Document Worker.
* **Chosen Approach:** **Pre-Render Item Counting + Heavy-Document Isolation Lane.**
* **Why:** Splitting an invoice across files alters legal totals and tax page structures. Large tables (500+ items) trigger Puppeteer OOM crashes. Workers check row counts before rendering: tables with >250 items are routed to a dedicated Heavy Worker configured with a concurrency cap of 1–2 and a higher memory limit (`--max-old-space-size=1024`).
* **Trade-Off Accepted:** Heavy documents take slightly longer to process due to strict concurrency constraints.

---

### Decision 4: Resumable S3 Pre-Signed URLs & Individual Download Links
* **Alternatives Considered:** 
  1. Streaming monolithic ZIP archives directly through Django server memory.
  2. Local EC2 file storage.
  3. Direct S3 Pre-signed URLs with HTTP Range header support.
* **Chosen Approach:** **S3 Pre-Signed URLs with HTTP Range Headers + Per-Document Links.**
* **Why:** SMB users on weak internet connections frequently experience dropped TCP downloads on 50+ MB ZIP files. Pre-signed S3 links support HTTP `Range` headers natively, allowing browsers to automatically resume broken downloads without starting from byte 0. Providing individual PDF download links alongside the ZIP allows users to grab critical invoices immediately even if the big ZIP download drops.
* **Trade-Off Accepted:** Requires explicit S3 Lifecycle Rules to automatically clean up temporary ZIPs after 7 days.

---

### Decision 5: Restricted Column-Level Database SHA-256 Audit Logging
* **Alternatives Considered:** 
  1. Enterprise PKI / X.509 digital certificate signing.
  2. Storing raw SHA-256 hashes as S3 object metadata only.
  3. Writing SHA-256 hashes to an in-database restricted audit table (`AuditVault`).
* **Chosen Approach:** **SHA-256 Checksum stored in Restricted PostgreSQL Table.**
* **Why:** Enterprise PKI adds significant monetary cost and complexity. Storing hashes only in S3 allows anyone with S3 write access to overwrite both the file and metadata. Calculating a SHA-256 hash over raw PDF bytes upon render and logging `(document_id, sha256_hash, timestamp, version_id)` into a Column-Level Security restricted PostgreSQL table proves tamper evidence at zero extra infra cost.
* **Trade-Off Accepted:** Proves document integrity against post-generation modification, but does not display a visible digital signature stamp inside desktop PDF readers.

---

## 5. AI Usage Log

Prompts and architectural evaluation logs generated during design review:

1. **Prompt:** "Analyze the trade-offs between holding synchronous HTTP connections vs queue-based worker execution for Puppeteer PDF generation under 400MB memory constraints."
   * *Outcome:* Confirmed synchronous processing causes worker thread exhaustion; queue-based decoupled architecture is required.
2. **Prompt:** "Calculate worker memory footprints for 1,000 requests/minute given 2.5s render latency and 400MB per render."
   * *Outcome:* Derived Little's Law math and identified the contradiction between peak throughput and the ₹12,500 budget limit.
3. **Prompt:** "How do we handle stale GST invoice data during long-running bulk PDF generation without keeping open DB transactions?"
   * *Outcome:* Selected point-in-time JSON snapshotting to S3 over long-running DB read locks.
4. **Prompt:** "How do we prevent 500+ line item Puppeteer OOM crashes from killing the queue worker thread?"
   * *Outcome:* Formulated pre-render inspection and heavy-document worker isolation.

*Public conversation sharing links:*
- `https://chatgpt.com/share/placeholder-link-1` *(Update after generating public link)*
- `https://chatgpt.com/share/placeholder-link-2` *(Update after generating public link)*

---

## 6. Weaknesses & Future Improvements

### Weaknesses in Current Design
1. **Queue Wait Times Under Peak Spikes:** Because Fast-Lane concurrency is capped at 8 workers to protect RAM bounds, a sudden surge of 1,000 single requests will experience short queue wait times (~20–30s), temporarily exceeding the 5-second download SLA.
2. **Static Node Capacity:** Worker node capacity is statically sized rather than dynamically scaled based on queue depth.

### What I Would Improve With 2 More Days
1. **Puppeteer Browser Pool Lifecycle Manager:** Implement explicit browser tab recycling using `generic-pool` to close Chromium contexts every 20 renders or when tab memory crosses 600 MB.
2. **Failed Job Admin Dashboard:** Create an operational UI to inspect jobs in the `dead-letter-queue` (DLQ) and trigger manual single-document retries.

### Scaling to 10x Load
1. **Autoscaling Worker Fleet:** Migrate Node.js workers from a fixed EC2 instance to AWS ECS Fargate tasks with dynamic target-tracking autoscaling based on BullMQ queue depth.
2. **Global CDN Storage Acceleration:** Place AWS CloudFront in front of the S3 bucket to accelerate PDF file delivery for geographically distributed clients.

---

## 7. One Thing the Problem Statement Didn't Mention
**Zombie Chromium Process Management and Host Memory Pollution.**

In production Node.js environments, headless Chrome child processes occasionally fail to terminate cleanly when a worker thread times out or encounters an unhandled exception. These orphan "zombie" processes continue consuming ~400 MB of system RAM in the background without returning memory to the operating system.

Over time, accumulated zombie processes pollute host memory, leading to kernel OOM panics that crash adjacent service components. A production deployment requires process supervision (`tini` or `dumb-init` entrypoints inside Docker containers) alongside scheduled cleanup commands (`pkill -f chrome`) to maintain long-term host stability.

---

## 8. Cost Estimation

Monthly infrastructure cost breakdown for generating **30,000 PDFs/month** under the **₹12,500 (~$150 USD)** budget constraint:

| Component | Specification / Details | Monthly Cost (USD) | Monthly Cost (INR @ ₹83/$) |
| :--- | :--- | :--- | :--- |
| **Compute Worker** | AWS EC2 `t4g.xlarge` Reserved (4 vCPUs, 16 GB RAM, ARM) | $48.00 | ₹3,984 |
| **Primary Monolith & DB**| Existing EC2 (`r6i.large`), RDS PostgreSQL, & Redis[cite: 2] | $0.00 *(Existing)* | ₹0 *(Existing)* |
| **Object Storage (S3)** | 30,000 PDFs/mo $\times$ 0.5 MB = 15 GB storage + Snapshots[cite: 1, 2] | $0.35 | ₹29 |
| **Network Data Transfer**| 15 GB outbound download bandwidth | $1.35 | ₹112 |
| **S3 API Requests** | ~100,000 PUT/GET requests | $0.40 | ₹33 |
| **Monitoring & Logs** | AWS CloudWatch Logs (2 GB retention) | $1.50 | ₹125 |
| **Buffer / Contingency**| Elasticity allowance for peak traffic surges | $15.00 | ₹1,245 |
| **TOTAL ESTIMATED COST**| **Fully provisioned production architecture** | **~$66.60 / mo** | **~₹5,528 / mo** |

*Conclusion:* The proposed design runs at approximately **₹5,528/month**, leaving a ~55% safety margin under the **₹12,500/month** budget ceiling.
