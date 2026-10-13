
[![Architecture](https://img.shields.io/badge/Architecture-Asynchronous_Microservice-blue.svg)](#architecture-overview)
[![Engine](https://img.shields.io/badge/Rendering-Puppeteer_%2F_Chromium-green.svg)](#tech-stack)
[![Queue](https://img.shields.io/badge/Queue-BullMQ_%2B_Redis-red.svg)](#tech-stack)
[![Budget](https://img.shields.io/badge/Monthly_Budget-%3C_₹12%2C500-success.svg)](#cost-estimation)

A resilient, scalable, and budget-conscious PDF Generation Microservice designed to integrate seamlessly with an existing Django ERP monolith without requiring a core system re-architecture. Built to handle single-document instant downloads and bulk PDF generation jobs (up to 100 PDFs per request) under real-world Small and Medium Business (SMB) network conditions.

---

## 📌 Problem Overview

The ERP platform requires offloading intensive HTML-to-PDF template rendering from its core Django application. Core challenges addressed in this design include:

* **Resource Control:** Puppeteer renders temporarily consume ~400 MB RAM per document. Unbounded parallel processing causes host Out-Of-Memory (OOM) crashes.
* **Strict SLAs vs. Bulk Workloads:** Single document downloads must start within **5 seconds**, requiring total isolation from long-running bulk export jobs.
* **Data Consistency:** Bulk generation jobs taking 3+ minutes are prone to data drift if primary database records are updated mid-job.
* **Unreliable Client Networks:** SMB users on weak internet connections frequently face interrupted downloads on 50+ MB bulk ZIP files.
* **Budget Constraint:** Total infrastructure cost must stay under **₹12,500/month (~$131.58 USD at ₹95/$)** for ~30,000 PDFs/month.

---

## 🏗️ Architecture Overview

> **Full High-Resolution Diagram:** See [`architecture-diagram.png`](./architecture-diagram.png) in the repository root.
    
---

## 🔑 Key Engineering Decisions

| Problem Area | Chosen Solution | Technical Justification |
| :--- | :--- | :--- |
| **Request Isolation** | Dual Queueing (`single-pdf-queue` & `bulk-pdf-queue`) using BullMQ & Redis | Single requests use reserved fast-lane concurrency slots (Cap = 8), preventing head-of-line blocking behind long bulk jobs. |
| **Bulk Data Consistency** | Point-in-Time Payload Snapshotting to AWS S3 | Django writes an immutable snapshot (`/snapshots/{job_id}.json`) at job creation. Workers read from the same snapshot, preventing stale data across all 100 PDFs. |
| **Large Documents (500+ Items)** | Pre-Render Row Inspection & Heavy Isolation Lane | Invoices exceeding 250 rows route to a dedicated Heavy Worker thread with strict concurrency (1–2) and higher V8 heap bounds, preventing Chromium OOM crashes. |
| **Resilient Deliveries** | Pre-Signed S3 URLs with HTTP Range Headers | Enables byte-level download resuming for SMB clients on flaky internet connections. Returns individual PDF links alongside bulk ZIP archives. |
| **Tamper Evidence** | Restricted SHA-256 Audit Table in PostgreSQL | SHA-256 hashes are calculated on raw PDF bytes post-render and stored in a restricted database audit log (`AuditVault`) for zero-cost verification. |

---

## 🛠️ Tech Stack & Dependencies

* **Runtime Environment:** Node.js (v20+ LTS) running inside Docker containers on AWS EC2 `t4g.xlarge` (ARM64).
* **Rendering Engine:** Puppeteer / Headless Chromium with process flags (`--no-sandbox`, `--disable-dev-shm-usage`).
* **Queue & Caching:** BullMQ backed by existing ElastiCache Redis.
* **Primary Integration:** Python / Django Monolith (Existing) on EC2 `r6i.large`.
* **Database & Storage:** AWS RDS PostgreSQL (`db.r6i.large`) & AWS S3 Object Storage.

---

## 📐 Capacity Sizing & Cost Summary

### Resource Provisioning Baseline
* **Single Fast-Lane Capacity:** Capped at **8 concurrent workers**.
* **Bulk Batch-Lane Capacity:** Capped at **4 concurrent workers**.
* **Heavy Document Isolator:** Capped at **1–2 concurrent workers**.
* **Baseline Memory Footprint:** $12 \text{ workers} \times 400 \text{ MB} = 4.8 \text{ GB RAM}$. Host RAM (16 GB) provides ~11.2 GB headroom for OS, Chromium processes, and buffer pools.

### Monthly Cost Breakdown (30,000 PDFs/month)

| Component | Resource Details | Estimated Cost (USD) | Estimated Cost (INR @ ₹95/$) |
| :--- | :--- | :--- | :--- |
| **Compute Node** | AWS EC2 `t4g.xlarge` Reserved (4 vCPU, 16 GB RAM) | $48.00 | ₹4,560 |
| **Existing Infra** | Primary Django, RDS PostgreSQL, & Redis | $0.00 *(Existing)* | ₹0 *(Existing)* |
| **Storage & Transfer** | AWS S3 Storage (15 GB) + Outbound Bandwidth + API Calls | $2.10 | ₹200 |
| **Monitoring & Buffer**| CloudWatch Logs + Elasticity Surge Allowance | $16.50 | ₹1,567 |
| **TOTAL COST** | **Fully Provisioned Infrastructure** | **~$66.60 / mo** | **~₹6,327 / mo** |

> **Budget Margin:** Operating at **~₹6,327/month** leaves a **~49% safety margin** under the **₹12,500/month** limit.

---

## 📄 Documentation & Submission References

For complete technical explanations, Little's Law calculations, AI conversation logs, and trade-off analyses, refer to [`APPROACH.md`](./APPROACH.md).

* **Collaborators Added:** `sun337`, `rss-holmes`
* **Repository Status:** Private
