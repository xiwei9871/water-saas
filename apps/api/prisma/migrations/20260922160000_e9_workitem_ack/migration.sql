-- E9: align WorkItemStatus with the Gate enum (OPEN ACK IGNORED RESOLVED).
ALTER TYPE "WorkItemStatus" RENAME VALUE 'ACKNOWLEDGED' TO 'ACK';
