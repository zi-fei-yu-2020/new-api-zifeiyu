/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { cn } from '@/lib/utils'

export const richContentClassName = cn(
  'prose prose-sm max-w-none',
  '[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold',
  '[&_h2]:mt-5 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold',
  '[&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold',
  '[&_h4]:mt-4 [&_h4]:mb-2 [&_h4]:font-semibold',
  '[&_p]:my-2 [&_p]:leading-relaxed [&_strong]:font-semibold [&_em]:italic',
  '[&_a]:text-primary [&_a]:underline hover:[&_a]:text-primary/80',
  '[&_ol]:my-2 [&_ul]:my-2 [&_ol]:list-decimal [&_ul]:list-disc [&_ol]:pl-5 [&_ul]:pl-5 [&_li]:my-1 [&_li]:pl-1',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-primary [&_blockquote]:bg-muted/50 [&_blockquote]:py-1 [&_blockquote]:pl-4',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono',
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted [&_pre]:p-3 [&_table]:my-4 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-sm',
  '[&_thead]:bg-muted [&_th]:border [&_td]:border [&_th]:px-3 [&_td]:px-3 [&_th]:py-2 [&_td]:py-2 [&_th]:text-left',
  '[&_hr]:my-6 [&_img]:my-4 [&_img]:max-w-full [&_img]:rounded-lg',
  '[&_.katex-display]:my-4 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden',
  '[&_.markdown-page-break]:my-6 [&_.markdown-page-break]:border-dashed',
  '[&_.markdown-diagram]:my-4 [&_.markdown-diagram]:overflow-x-auto [&_.markdown-diagram]:rounded-md [&_.markdown-diagram]:border [&_.markdown-diagram]:bg-background [&_.markdown-diagram]:p-4',
  '[&_.markdown-diagram_svg]:mx-auto [&_.markdown-diagram_svg]:max-w-full',
  '[&_.markdown-diagram-node]:fill-[color-mix(in_oklch,var(--primary)_8%,var(--background))] [&_.markdown-diagram-node]:stroke-primary [&_.markdown-diagram-node]:stroke-[1.5]',
  '[&_.markdown-diagram-text]:fill-foreground [&_.markdown-diagram-text]:text-sm [&_.markdown-diagram-text]:font-medium',
  '[&_.markdown-diagram-edge]:stroke-muted-foreground [&_.markdown-diagram-edge]:stroke-[1.5] [&_.markdown-diagram-edge]:fill-none',
  '[&_.markdown-diagram-arrow]:fill-muted-foreground',
  '[&_.markdown-diagram-edge-label]:fill-muted-foreground [&_.markdown-diagram-edge-label]:text-xs',
  '[&_.markdown-sequence-lifeline]:stroke-primary [&_.markdown-sequence-lifeline]:stroke-[1.5]',
  '[&_.markdown-sequence-note]:fill-warning/20 [&_.markdown-sequence-note]:stroke-warning',
  '[&_.markdown-sequence-note-text]:fill-foreground [&_.markdown-sequence-note-text]:text-xs',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[overflow-wrap:anywhere]'
)
