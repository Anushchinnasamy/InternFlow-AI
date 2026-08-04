import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface NdaPdfData {
  candidateName: string;
  nonWorkerId: string;
  mentorName: string;
  projectTitle: string;
  startDate: Date;
  endDate: Date;
  // When present, renders a signature block — this is what makes a signed
  // version's PDF bytes (and therefore its SHA-256) differ from the
  // unsigned version rather than being a duplicate.
  signature?: { typedName: string; signedAt: Date };
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function generateNdaPdf(data: NdaPdfData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = 740;
  const line = (text: string, size = 11, useBold = false) => {
    page.drawText(text, { x: 50, y, size, font: useBold ? bold : font, color: rgb(0, 0, 0) });
    y -= size + 8;
  };

  line("NON-DISCLOSURE AGREEMENT", 16, true);
  y -= 10;
  line(`Candidate: ${data.candidateName}`);
  line(`Non-Worker ID: ${data.nonWorkerId}`);
  line(`Mentor: ${data.mentorName}`);
  line(`Project: ${data.projectTitle}`);
  line(`Internship period: ${formatDate(data.startDate)} to ${formatDate(data.endDate)}`);
  y -= 10;

  // TODO: replace with Legal-approved template per spec dependency D-1.
  // Placeholder clause only — not reviewed by Legal.
  const placeholderClause = [
    "This is placeholder legal text pending Legal's approved NDA template (see spec",
    "dependency D-1). By signing, the above-named candidate acknowledges this is an",
    "unpaid internship creating no employment relationship, and agrees to keep",
    "confidential all proprietary, technical, and business information encountered",
    "during the internship, both during and after its term.",
  ];
  for (const clauseLine of placeholderClause) {
    line(clauseLine, 10);
  }

  if (data.signature) {
    y -= 20;
    line(`Signed by: ${data.signature.typedName}`, 11, true);
    line(`Signed at: ${data.signature.signedAt.toISOString()}`, 10);
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
