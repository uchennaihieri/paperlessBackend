-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "branch" VARCHAR(100),
    "login_id" VARCHAR(50),
    "user_no" VARCHAR(50),
    "user_role" VARCHAR(50),
    "employee_id" VARCHAR(50),
    "user_name" VARCHAR(150),
    "finca_email" VARCHAR(150),
    "lock_flag" BOOLEAN,
    "effective_date" DATE,
    "customer_number" VARCHAR(50),
    "creation_date" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(50),
    "status" VARCHAR(20),
    "passwordHash" TEXT,
    "mustResetPassword" BOOLEAN NOT NULL DEFAULT true,
    "passwordChangedAt" TIMESTAMP(3),
    "specialAccess" VARCHAR(100),
    "signature" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "mobileEnabled" BOOLEAN NOT NULL DEFAULT false,
    "accountServicesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "fields" JSONB NOT NULL,
    "htmlTemplate" TEXT,
    "formOwner" TEXT,
    "formTreater" TEXT,
    "pdfGeneratorType" TEXT NOT NULL DEFAULT 'none',
    "pdfTemplateId" TEXT,
    "needsContract" BOOLEAN NOT NULL DEFAULT false,
    "contractTemplateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormSubmission" (
    "id" TEXT NOT NULL,
    "reference" TEXT,
    "alias" TEXT,
    "formName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "formResponses" JSONB NOT NULL,
    "signingType" TEXT NOT NULL DEFAULT 'sequential',
    "treatedBy" TEXT,
    "treaterEmail" TEXT,
    "approvedBy" TEXT,
    "approverEmail" TEXT,
    "submittedById" INTEGER,
    "templateId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_audit_trail" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "formReference" TEXT,
    "prevStatus" TEXT NOT NULL,
    "newStatus" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorName" TEXT,
    "actorEmail" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_audit_trail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_documents" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "size" INTEGER NOT NULL DEFAULT 0,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionSignatory" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "userName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3),
    "signatureToken" TEXT,
    "signatureData" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "declineReason" TEXT,

    CONSTRAINT "SubmissionSignatory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionPrerequisite" (
    "id" TEXT NOT NULL,
    "mainSubmissionId" TEXT NOT NULL,
    "prereqSubmissionId" TEXT,
    "targetFormId" TEXT NOT NULL,
    "targetEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',

    CONSTRAINT "SubmissionPrerequisite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityData" (
    "id" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "hashedToken" TEXT NOT NULL,
    "encryptedSignature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "script" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_access" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pdf_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'document',
    "sharepointPath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pdf_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pdf_template_fields" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "mappingPath" TEXT,
    "page" INTEGER NOT NULL DEFAULT 0,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pdf_template_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_verification_logs" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "idType" TEXT NOT NULL,
    "idNumber" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'Verified',
    "pdfPath" TEXT,
    "requestData" JSONB NOT NULL,
    "responseData" JSONB NOT NULL,
    "verifiedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_verification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_access" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" TEXT NOT NULL,

    CONSTRAINT "form_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "journalId" VARCHAR(50),
    "committed" BOOLEAN NOT NULL DEFAULT false,
    "sessionRef" TEXT NOT NULL,
    "formName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "batchNumber" TEXT,
    "branch" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "batchGroupId" TEXT,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_registrations" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "approvedBy" TEXT,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "device_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lookup_values" (
    "id" TEXT NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "value" VARCHAR(150) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lookup_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_bureau_logs" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "bureau" TEXT NOT NULL,
    "bvn" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'Match Found',
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "enquiryReason" TEXT NOT NULL DEFAULT 'Credit Check',
    "productId" INTEGER NOT NULL DEFAULT 45,
    "pdfPath" TEXT,
    "requestData" JSONB NOT NULL,
    "responseData" JSONB NOT NULL,
    "reportData" JSONB,
    "verifiedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_bureau_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reusable_lists" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "items" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reusable_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_requests" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "submitterEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "signedAt" TIMESTAMP(3),
    "signatureToken" TEXT,
    "pdfPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FormTemplate_name_key" ON "FormTemplate"("name");

-- CreateIndex
CREATE UNIQUE INDEX "FormSubmission_reference_key" ON "FormSubmission"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionSignatory_submissionId_position_key" ON "SubmissionSignatory"("submissionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionPrerequisite_prereqSubmissionId_key" ON "SubmissionPrerequisite"("prereqSubmissionId");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionPrerequisite_mainSubmissionId_targetFormId_target_key" ON "SubmissionPrerequisite"("mainSubmissionId", "targetFormId", "targetEmail");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_email_token_key" ON "VerificationToken"("email", "token");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityData_userEmail_key" ON "SecurityData"("userEmail");

-- CreateIndex
CREATE UNIQUE INDEX "report_access_reportId_userEmail_key" ON "report_access"("reportId", "userEmail");

-- CreateIndex
CREATE UNIQUE INDEX "pdf_templates_name_key" ON "pdf_templates"("name");

-- CreateIndex
CREATE UNIQUE INDEX "identity_verification_logs_reference_key" ON "identity_verification_logs"("reference");

-- CreateIndex
CREATE INDEX "identity_verification_logs_idType_idNumber_idx" ON "identity_verification_logs"("idType", "idNumber");

-- CreateIndex
CREATE INDEX "identity_verification_logs_idType_idx" ON "identity_verification_logs"("idType");

-- CreateIndex
CREATE UNIQUE INDEX "form_access_templateId_userEmail_key" ON "form_access"("templateId", "userEmail");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_entryId_key" ON "journal_entries"("entryId");

-- CreateIndex
CREATE INDEX "journal_entries_sessionRef_idx" ON "journal_entries"("sessionRef");

-- CreateIndex
CREATE INDEX "journal_entries_committed_idx" ON "journal_entries"("committed");

-- CreateIndex
CREATE INDEX "journal_entries_batchGroupId_idx" ON "journal_entries"("batchGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "device_registrations_userId_deviceId_key" ON "device_registrations"("userId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "lookup_values_type_value_key" ON "lookup_values"("type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "credit_bureau_logs_reference_key" ON "credit_bureau_logs"("reference");

-- CreateIndex
CREATE INDEX "credit_bureau_logs_bureau_idx" ON "credit_bureau_logs"("bureau");

-- CreateIndex
CREATE INDEX "credit_bureau_logs_bvn_idx" ON "credit_bureau_logs"("bvn");

-- CreateIndex
CREATE UNIQUE INDEX "reusable_lists_name_key" ON "reusable_lists"("name");

-- AddForeignKey
ALTER TABLE "FormTemplate" ADD CONSTRAINT "FormTemplate_pdfTemplateId_fkey" FOREIGN KEY ("pdfTemplateId") REFERENCES "pdf_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FormTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_audit_trail" ADD CONSTRAINT "form_audit_trail_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "FormSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_documents" ADD CONSTRAINT "submission_documents_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "FormSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionSignatory" ADD CONSTRAINT "SubmissionSignatory_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "FormSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionPrerequisite" ADD CONSTRAINT "SubmissionPrerequisite_mainSubmissionId_fkey" FOREIGN KEY ("mainSubmissionId") REFERENCES "FormSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionPrerequisite" ADD CONSTRAINT "SubmissionPrerequisite_prereqSubmissionId_fkey" FOREIGN KEY ("prereqSubmissionId") REFERENCES "FormSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionPrerequisite" ADD CONSTRAINT "SubmissionPrerequisite_targetFormId_fkey" FOREIGN KEY ("targetFormId") REFERENCES "FormTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_access" ADD CONSTRAINT "report_access_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pdf_template_fields" ADD CONSTRAINT "pdf_template_fields_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pdf_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_access" ADD CONSTRAINT "form_access_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FormTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_registrations" ADD CONSTRAINT "device_registrations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_requests" ADD CONSTRAINT "contract_requests_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "FormSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

