-- B2：违章来源扩展 FIELD（现场巡检/抄表 APP 无读数场景的"疑是违章"上报）。
ALTER TABLE "water_violation" DROP CONSTRAINT "water_violation_source_type_check";
ALTER TABLE "water_violation" ADD CONSTRAINT "water_violation_source_type_check"
  CHECK ("source_type" IN ('INSPECT', 'READING', 'FIELD'));
