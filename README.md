# Paperless Backend API

Production-grade Express.js REST API for the Paperless Operations Platform.

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js + TypeScript |
| Framework | Express 4 |
| ORM | Prisma 5 + PostgreSQL |
| Auth | JWT (jsonwebtoken) |
| Email | Nodemailer (Zoho SMTP) |
| PDF | Puppeteer |
| Upload | Multer |
| Logging | Winston + Morgan |
| Security | Helmet, CORS, express-rate-limit |

## Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Generate the Prisma client
npm run db:generate

# 3. (Optional) Push schema to DB or run migrations
npm run db:push

# 4. Seed default form templates
npm run db:seed

# 5. Start the dev server (hot-reload)
npm run dev
```

The API will be available at **http://localhost:4000**.

## API Reference

All endpoints are prefixed with `/api/v1`.

### Authentication
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/send-otp` | ❌ | Send OTP to email |
| POST | `/auth/verify-otp` | ❌ | Verify OTP → returns JWT |

### Form Templates
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/forms` | ✅ | List all templates |
| GET | `/forms/branches` | ✅ | Distinct active branches |
| GET | `/forms/search-users?q=` | ✅ | Search users for signatories |
| GET | `/forms/:id` | ✅ | Get single template |
| POST | `/forms` | ✅ Admin | Create template |
| PATCH | `/forms/:id` | ✅ Admin | Update template |
| DELETE | `/forms/:id` | ✅ Admin | Delete template |

### Submissions
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/submissions` | ✅ | All submissions |
| GET | `/submissions/my` | ✅ | User's own submissions |
| GET | `/submissions/action-items` | ✅ | Action center items (by branch) |
| GET | `/submissions/:id` | ✅ | Single submission detail |
| POST | `/submissions` | ✅ | Submit a new form |
| POST | `/submissions/:id/file-attachments` | ✅ | File & archive a submission |

### Workflow
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/workflow/queue` | ✅ | Pending signing queue |
| GET | `/workflow/search-users?q=` | ✅ | Search for approvers |
| GET | `/workflow/submissions/:id` | ✅ | Submission detail for review |
| POST | `/workflow/:id/assign-self` | ✅ | Assign to myself |
| POST | `/workflow/:id/complete` | ✅ | Complete / route to approver |
| POST | `/workflow/:id/approve` | ✅ | Final approver approval |
| POST | `/workflow/:id/sign` | ✅ | Sign with data or token |
| POST | `/workflow/:id/decline` | ✅ | Decline / reject |

### Security (Token Signature)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/security/register` | ✅ | Register token + signature blob |
| POST | `/security/verify-token` | ✅ | Verify token, returns signature |
| GET | `/security/my-signature` | ✅ | Get own decrypted signature |

### Teams (Admin only)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/teams` | ✅ Admin | All users grouped by email |
| POST | `/teams` | ✅ Admin | Add user role |
| PATCH | `/teams/:id/status` | ✅ Admin | Update role status / lock |
| PATCH | `/teams/bulk-info` | ✅ Admin | Update shared user info |
| DELETE | `/teams/:id` | ✅ Admin | Remove user role |

### File & PDF
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/upload` | ✅ | Upload files (multipart/form-data key: `files`) |
| GET | `/file?id=` | ✅ | Serve a stored file |
| GET | `/pdf?id=&action=` | ✅ | Generate PDF (`action=print` or omit for download) |

### Mobile
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/mobile/auth/send-otp` | ❌ | Send mobile OTP |
| POST | `/mobile/auth/verify-otp` | ❌ | Verify OTP → 30-day JWT |
| GET | `/mobile/dashboard?userId=` | ❌ | Stats + submissions for user |
| POST | `/mobile/submissions/deposit` | ❌ | Submit deposit account form |
| POST | `/mobile/submissions/partial` | ❌ | Save draft step |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `JWT_SECRET` | — | Secret for signing JWTs |
| `PORT` | `4000` | HTTP port |
| `NODE_ENV` | `development` | Environment |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated CORS origins |
| `SMTP_HOST` | `smtp.zoho.com` | SMTP server host |
| `SMTP_PORT` | `465` | SMTP port |
| `SMTP_SECURE` | `true` | TLS |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |
| `UPLOAD_DIR` | `C:\Users\USER\uploads` | Where uploaded files are stored |

## Project Structure

```
paperlessBackend/
├── prisma/
│   ├── schema.prisma      # Database schema
│   └── seed.ts            # Seed script
├── src/
│   ├── index.ts           # App entry point
│   ├── lib/
│   │   ├── prisma.ts      # Prisma singleton
│   │   ├── logger.ts      # Winston logger
│   │   ├── mailer.ts      # Nodemailer transporter
│   │   └── crypto.ts      # AES-256 encrypt/decrypt + hash
│   ├── middleware/
│   │   ├── authenticate.ts # JWT auth + admin guard
│   │   ├── errorHandler.ts # Global error handler
│   │   └── notFound.ts     # 404 handler
│   └── routes/
│       ├── auth.ts
│       ├── forms.ts
│       ├── submissions.ts
│       ├── workflow.ts
│       ├── security.ts
│       ├── teams.ts
│       ├── upload.ts
│       ├── files.ts
│       ├── pdf.ts
│       ├── mobile.ts
│       └── mobile/
│           ├── sendOtp.ts
│           ├── verifyOtp.ts
│           ├── dashboard.ts
│           ├── deposit.ts
│           └── partial.ts
├── .env
├── .gitignore
├── package.json
└── tsconfig.json
```
