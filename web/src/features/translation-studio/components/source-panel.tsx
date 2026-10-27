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
import { FileText, ImagePlus, Upload, X, Loader2 } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatNumber } from '@/lib/format'

import { MAX_SOURCE_CHARACTERS } from '../lib/source'
import type { TranslationMode, TranslationSource } from '../types'

type Props = {
  mode: TranslationMode
  onModeChange: (mode: TranslationMode) => void
  text: string
  onTextChange: (text: string) => void
  source: TranslationSource | null
  fileName: string
  preparing: boolean
  busy: boolean
  onFile: (file: File) => void
  onRemove: () => void
}

export function TranslationSourcePanel(props: Props) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const accept =
    props.mode === 'image'
      ? 'image/png,image/jpeg,image/webp'
      : '.pdf,.docx,.txt,.md'
  let fileDetails = t('Reading your file locally...')
  if (!props.preparing && props.source) {
    fileDetails = `${formatNumber(Math.ceil(props.source.size / 1024))} KB`
    if (props.source.pages > 0) {
      fileDetails += ` · ${t('{{count}} pages', { count: props.source.pages })}`
    } else if (props.source.text) {
      fileDetails += ` · ${t('{{count}} characters', { count: props.source.text.length })}`
    }
  }
  let preview: ReactNode = null
  if (props.preparing) {
    preview = (
      <div className='translation-reading' role='status'>
        <Loader2 className='animate-spin' aria-hidden='true' />
        {t('Preparing the source...')}
      </div>
    )
  } else if (props.source?.preview) {
    preview = (
      <div className='translation-image-preview'>
        <img src={props.source.preview} alt={t('Source preview')} />
        {props.source.text && (
          <pre className='translation-extracted-text'>{props.source.text}</pre>
        )}
      </div>
    )
  } else if (props.source?.text) {
    preview = (
      <pre
        className='translation-extracted-text'
        aria-label={t('Extracted source text')}
        dir='auto'
      >
        {props.source.text}
      </pre>
    )
  }
  let footnote =
    props.mode === 'text'
      ? t('Up to 100,000 characters. Long content is translated in sections.')
      : t(
          'Files are read locally and sent to the selected model only when you translate.'
        )
  if (props.source?.imagePages) {
    footnote = t(
      '{{count}} image pages need a model with image understanding.',
      { count: props.source.imagePages }
    )
  }
  return (
    <section
      className='translation-panel'
      aria-labelledby='translation-source-title'
    >
      <div className='translation-panel-heading'>
        <h2 id='translation-source-title'>{t('Source content')}</h2>
        <span>
          {props.mode === 'text'
            ? t('{{count}} characters', { count: props.text.length })
            : t('File translation')}
        </span>
      </div>
      <ToggleGroup
        aria-label={t('Translation input type')}
        value={[props.mode]}
        disabled={props.busy || props.preparing}
        onValueChange={(values) => {
          const next = values[0]
          if (next === 'text' || next === 'image' || next === 'document') {
            props.onModeChange(next)
          }
        }}
        className='translation-modes'
      >
        <ToggleGroupItem value='text'>{t('Text')}</ToggleGroupItem>
        <ToggleGroupItem value='image'>{t('Image')}</ToggleGroupItem>
        <ToggleGroupItem value='document'>
          {t('Documents / PDF')}
        </ToggleGroupItem>
      </ToggleGroup>
      {props.mode === 'text' ? (
        <Textarea
          aria-label={t('Text to translate')}
          dir='auto'
          value={props.text}
          onChange={(event) => props.onTextChange(event.target.value)}
          placeholder={t(
            'Paste the text you want to translate. Paragraphs, lists and terminology will be kept in context.'
          )}
          maxLength={MAX_SOURCE_CHARACTERS}
          readOnly={props.busy}
          className='translation-source-text'
        />
      ) : (
        <div className='translation-file-content'>
          <input
            ref={inputRef}
            type='file'
            accept={accept}
            className='sr-only'
            tabIndex={-1}
            aria-label={t('Upload translation source')}
            disabled={props.busy || props.preparing}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) props.onFile(file)
              event.target.value = ''
            }}
          />
          {props.fileName ? (
            <>
              <div className='translation-file-heading'>
                <FileText size={20} aria-hidden='true' />
                <div className='min-w-0 flex-1'>
                  <p className='truncate font-medium' title={props.fileName}>
                    {props.fileName}
                  </p>
                  <p className='translation-caption'>{fileDetails}</p>
                </div>
                <Button
                  variant='ghost'
                  size='icon'
                  className='size-11'
                  aria-label={t('Remove source file')}
                  onClick={props.onRemove}
                  disabled={props.busy}
                >
                  <X size={16} aria-hidden='true' />
                </Button>
              </div>
              {preview}
            </>
          ) : (
            <Button
              type='button'
              variant='ghost'
              className='translation-dropzone'
              disabled={props.busy}
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                if (props.busy || props.preparing) return
                const file = event.dataTransfer.files[0]
                if (file) props.onFile(file)
              }}
            >
              {props.mode === 'image' ? (
                <ImagePlus
                  className='size-9'
                  strokeWidth={1}
                  aria-hidden='true'
                />
              ) : (
                <Upload className='size-9' strokeWidth={1} aria-hidden='true' />
              )}
              <strong>{t('Drop a file here, or click to choose')}</strong>
              <span>
                {props.mode === 'image'
                  ? t('PNG, JPG or WebP · up to 10 MB')
                  : t('PDF, DOCX, TXT or Markdown · up to 10 MB')}
              </span>
            </Button>
          )}
        </div>
      )}
      <div className='translation-panel-footnote'>{footnote}</div>
    </section>
  )
}
