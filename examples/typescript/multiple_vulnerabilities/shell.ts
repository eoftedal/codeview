import { exec } from 'child_process'
import { promisify } from 'util'

const run = promisify(exec)

export class ExportJob {
  constructor(readonly name: string) {}

  command(): string {
    return `pdfgen --template report --out /tmp/${this.name}.pdf`
  }
}

export async function exportReport(name: string): Promise<string> {
  const job = new ExportJob(name)
  const { stdout } = await run(job.command())
  return stdout.trim()
}
