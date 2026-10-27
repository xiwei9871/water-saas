ALTER TABLE "install_application"
  ADD COLUMN "cert_type" TEXT,
  ADD COLUMN "cert_no" TEXT,
  ADD COLUMN "cert_photo" JSONB;
