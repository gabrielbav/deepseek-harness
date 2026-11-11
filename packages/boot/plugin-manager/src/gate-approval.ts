/**
 * The conversation approval a `review` gate report asks for: the question, the gates' reasons, their checks and the
 * findings the person reads before installing anyway. The text is display-only; it never reaches the model or the
 * session log.
 * @module @deepseek-ai/dsh-plugin-manager/gate-approval
 */
import type { InstallGateReport, InstallGateSeverity, InstallGateText } from './types.ts'

type Locale = 'en' | 'zh' | 'ja' | 'es' | 'fr' | 'de' | 'ru' | 'pt'

/** Findings listed in the approval before the remainder is counted. */
const LISTED_FINDINGS = 8

/** The longest finding title the approval shows. */
const TITLE_LIMIT = 160

interface Copy {
  readonly question: (name: string) => string
  readonly score: (score: number) => string
  readonly why: string
  readonly checks: string
  readonly findings: (count: number) => string
  readonly more: (count: number) => string
  readonly none: string
  readonly severities: Readonly<Record<InstallGateSeverity, string>>
}

const COPY: Readonly<Record<Locale, Copy>> = {
  en: {
    question: name => `Install ${name} anyway? An install check needs your review.`,
    score: score => `Score ${score}/100.`,
    why: 'Why', checks: 'Checks', findings: count => `Findings (${count})`,
    more: count => `… and ${count} more, listed on the Plugins page`, none: 'No findings.',
    severities: { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW', info: 'INFO' },
  },
  zh: {
    question: name => `仍然安装 ${name}？安装检查需要你审查。`,
    score: score => `评分 ${score}/100。`,
    why: '原因', checks: '检查', findings: count => `发现（${count}）`,
    more: count => `… 另有 ${count} 项，见插件页面`, none: '没有发现。',
    severities: { critical: '严重', high: '高', medium: '中', low: '低', info: '信息' },
  },
  ja: {
    question: name => `それでも ${name} をインストールしますか？インストールチェックの確認が必要です。`,
    score: score => `スコア ${score}/100。`,
    why: '理由', checks: 'チェック', findings: count => `検出結果（${count}）`,
    more: count => `… ほか ${count} 件はプラグインページに表示`, none: '検出結果はありません。',
    severities: { critical: '重大', high: '高', medium: '中', low: '低', info: '情報' },
  },
  es: {
    question: name => `¿Instalar ${name} de todos modos? Una comprobación de instalación requiere su revisión.`,
    score: score => `Puntuación ${score}/100.`,
    why: 'Motivo', checks: 'Comprobaciones', findings: count => `Hallazgos (${count})`,
    more: count => `… y ${count} más, en la página de complementos`, none: 'No hay hallazgos.',
    severities: { critical: 'CRÍTICO', high: 'ALTO', medium: 'MEDIO', low: 'BAJO', info: 'INFO' },
  },
  fr: {
    question: name => `Installer ${name} quand même ? Une vérification d'installation demande votre examen.`,
    score: score => `Score ${score}/100.`,
    why: 'Pourquoi', checks: 'Vérifications', findings: count => `Résultats (${count})`,
    more: count => `… et ${count} autres, sur la page Plugins`, none: 'Aucun résultat.',
    severities: { critical: 'CRITIQUE', high: 'ÉLEVÉ', medium: 'MOYEN', low: 'FAIBLE', info: 'INFO' },
  },
  de: {
    question: name => `${name} trotzdem installieren? Eine Installationsprüfung braucht Ihre Bestätigung.`,
    score: score => `Bewertung ${score}/100.`,
    why: 'Gründe', checks: 'Prüfungen', findings: count => `Befunde (${count})`,
    more: count => `… und ${count} weitere auf der Plugins-Seite`, none: 'Keine Befunde.',
    severities: { critical: 'KRITISCH', high: 'HOCH', medium: 'MITTEL', low: 'NIEDRIG', info: 'INFO' },
  },
  ru: {
    question: name => `Всё равно установить ${name}? Проверка перед установкой требует вашего решения.`,
    score: score => `Оценка ${score}/100.`,
    why: 'Причины', checks: 'Проверки', findings: count => `Находки (${count})`,
    more: count => `… и ещё ${count} на странице плагинов`, none: 'Находок нет.',
    severities: { critical: 'КРИТИЧНО', high: 'ВЫСОКАЯ', medium: 'СРЕДНЯЯ', low: 'НИЗКАЯ', info: 'ИНФО' },
  },
  pt: {
    question: name => `Instalar ${name} mesmo assim? Uma verificação de instalação precisa da sua revisão.`,
    score: score => `Pontuação ${score}/100.`,
    why: 'Motivo', checks: 'Verificações', findings: count => `Resultados (${count})`,
    more: count => `… e mais ${count}, na página de plugins`, none: 'Nenhum resultado.',
    severities: { critical: 'CRÍTICO', high: 'ALTO', medium: 'MÉDIO', low: 'BAIXO', info: 'INFO' },
  },
}

const LOCALES = Object.keys(COPY) as Locale[]

/** Drop control characters and clip, so untrusted text stays one readable line. */
function line(text: string, limit: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** A gate's text in `locale`, else English. */
function localized(text: InstallGateText, locale: Locale): string {
  return text[locale] ?? text.en
}

function describe(report: InstallGateReport, copy: Copy, locale: Locale): string {
  const lines: string[] = []
  if (report.score !== undefined) lines.push(copy.score(report.score))
  if (report.reasons.length > 0) lines.push(`${copy.why}:`, ...report.reasons.map(reason => `• ${line(localized(reason, locale), 240)}`), '')
  const checks = report.checks ?? []
  if (checks.length > 0) {
    lines.push(`${copy.checks}: ${checks.map(check => `${line(check.name ?? check.id, 60)} ${check.status}${check.findings > 0 ? ` (${check.findings})` : ''}`).join(' · ')}`, '')
  }
  const total = report.findings.length + report.omittedFindings
  if (total === 0) lines.push(copy.none)
  else {
    lines.push(`${copy.findings(total)}:`)
    for (const finding of report.findings.slice(0, LISTED_FINDINGS)) {
      const where = finding.file === undefined ? '' : ` (${line(finding.file, 80)}${finding.line === undefined ? '' : `:${finding.line}`})`
      lines.push(`• [${copy.severities[finding.severity]}] ${line(finding.source, 40)}: ${line(finding.title, TITLE_LIMIT)}${where}`)
    }
    if (total > LISTED_FINDINGS) lines.push(copy.more(total - LISTED_FINDINGS))
  }
  return lines.join('\n').trim()
}

/** Localized display-only copy of one gate approval. */
export interface GateApprovalText {
  readonly displayReason: InstallGateText
  readonly displayDescription: InstallGateText
}

/**
 * The question and report a `review` ruling puts to the person in the conversation.
 * @param report The combined gate report.
 * @returns Localized question and detail for every shipped locale.
 */
export function gateApprovalText(report: InstallGateReport): GateApprovalText {
  const name = line(report.packageName ?? report.spec, 120)
  const pick = (render: (locale: Locale) => string): InstallGateText => ({ en: render('en'), ...Object.fromEntries(LOCALES.map(locale => [locale, render(locale)])) })
  return {
    displayReason: pick(locale => COPY[locale].question(name)),
    displayDescription: pick(locale => describe(report, COPY[locale], locale)),
  }
}
