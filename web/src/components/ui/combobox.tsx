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
import { Combobox as ComboboxPrimitive } from '@base-ui/react'
import { Check, ChevronDown, X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  ComboboxInput as LegacyComboboxInput,
  type ComboboxInputOption,
} from '@/components/ui/combobox-input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import { usePortalContainer } from '@/components/ui/portal-container'
import { cn } from '@/lib/utils'

type LegacyComboboxProps = {
  options: readonly ComboboxInputOption[]
  value?: string | null
  onValueChange?: (value: string | null) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  allowCustomValue?: boolean
  showSelectedIcon?: boolean
  className?: string
  popupClassName?: string
  id?: string
  openOnFocus?: boolean
  disabled?: boolean
  name?: string
  onBlur?: React.FocusEventHandler<HTMLInputElement>
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
  ref?: React.Ref<HTMLInputElement>
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
  'aria-invalid'?: React.AriaAttributes['aria-invalid']
}

function Combobox(props: LegacyComboboxProps): React.ReactElement
function Combobox<Value, Multiple extends boolean | undefined = false>(
  props: ComboboxPrimitive.Root.Props<Value, Multiple>
): React.ReactElement
function Combobox(
  props:
    | ComboboxPrimitive.Root.Props<unknown, boolean | undefined>
    | LegacyComboboxProps
) {
  if ('options' in props) {
    if (!props.allowCustomValue) return <OptionCombobox {...props} />
    return (
      <LegacyComboboxInput
        id={props.id}
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        aria-invalid={props['aria-invalid']}
        onKeyDown={props.onKeyDown}
        options={props.options}
        value={props.value ?? ''}
        onValueChange={(value) => props.onValueChange?.(value)}
        placeholder={props.searchPlaceholder ?? props.placeholder}
        emptyText={props.emptyText}
        className={props.className}
        popupClassName={props.popupClassName}
        allowCustomValue={props.allowCustomValue}
        openOnFocus={props.openOnFocus}
      />
    )
  }

  return <ComboboxPrimitive.Root {...props} />
}

function OptionCombobox(props: LegacyComboboxProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const anchor = useComboboxAnchor()
  const selected = props.options.find((option) => option.value === props.value)
  const displayedValue = selected?.label ?? props.value ?? ''
  return (
    <ComboboxPrimitive.Root
      items={props.options}
      value={selected ?? null}
      name={props.name}
      disabled={props.disabled}
      open={open && !props.disabled}
      inputValue={open ? search : displayedValue}
      onInputValueChange={(value, details) => {
        if (details.reason === 'input-change') setSearch(value)
      }}
      onOpenChange={(nextOpen, details) => {
        setOpen(nextOpen)
        if (details.reason !== 'input-change') setSearch('')
      }}
      onValueChange={(option) => {
        if (option) props.onValueChange?.(option.value)
      }}
      filter={(option, query) => {
        const term = query.trim().toLowerCase()
        return (
          option.label.toLowerCase().includes(term) ||
          option.value.toLowerCase().includes(term)
        )
      }}
      isItemEqualToValue={(item, value) => item.value === value.value}
    >
      <div ref={anchor} className={cn('min-w-0', props.className)}>
        <ComboboxInput
          ref={props.ref}
          id={props.id}
          disabled={props.disabled}
          onBlur={props.onBlur}
          onKeyDown={props.onKeyDown}
          onFocus={() => {
            // Dialog autofocus should not expand a select-style combobox.
            if (props.openOnFocus) setOpen(true)
          }}
          aria-label={props['aria-label']}
          aria-labelledby={props['aria-labelledby']}
          aria-describedby={props['aria-describedby']}
          aria-invalid={props['aria-invalid']}
          placeholder={
            props.searchPlaceholder ?? props.placeholder ?? t('Search...')
          }
          triggerAriaLabel={props['aria-label'] ?? t('Open')}
          className='h-full min-h-8 w-full'
        >
          {props.showSelectedIcon && !open && selected?.icon && (
            <InputGroupAddon align='inline-start' aria-hidden='true'>
              {selected.icon}
            </InputGroupAddon>
          )}
        </ComboboxInput>
      </div>
      <ComboboxContent anchor={anchor} className={props.popupClassName}>
        <ComboboxEmpty>
          {props.emptyText ?? t('No results found')}
        </ComboboxEmpty>
        <ComboboxList>
          {(option: ComboboxInputOption) => (
            <ComboboxItem
              key={option.value}
              value={option}
              disabled={option.disabled}
            >
              {option.icon && <span aria-hidden>{option.icon}</span>}
              <span className='min-w-0 break-words'>
                {option.label}
                {option.description && (
                  <span className='block text-xs break-all text-neutral-500'>
                    {option.description}
                  </span>
                )}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </ComboboxPrimitive.Root>
  )
}

function ComboboxValue({ ...props }: ComboboxPrimitive.Value.Props) {
  return <ComboboxPrimitive.Value data-slot='combobox-value' {...props} />
}

function ComboboxTrigger({
  className,
  children,
  ...props
}: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot='combobox-trigger'
      className={cn("[&_svg:not([class*='size-'])]:size-3.5", className)}
      {...props}
    >
      {children}
      <ChevronDown className='pointer-events-none size-3.5 text-neutral-500' />
    </ComboboxPrimitive.Trigger>
  )
}

function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props) {
  return (
    <ComboboxPrimitive.Clear
      data-slot='combobox-clear'
      render={
        <InputGroupButton
          variant='ghost'
          size='icon-xs'
          className='rounded-none hover:bg-neutral-100 hover:text-black'
        />
      }
      className={cn(className)}
      {...props}
    >
      <X className='pointer-events-none size-3.5' />
    </ComboboxPrimitive.Clear>
  )
}

function ComboboxInput({
  className,
  children,
  disabled = false,
  showTrigger = true,
  showClear = false,
  triggerAriaLabel,
  ...props
}: ComboboxPrimitive.Input.Props & {
  showTrigger?: boolean
  showClear?: boolean
  triggerAriaLabel?: string
}) {
  return (
    <InputGroup
      className={cn('w-auto rounded-none border-black bg-white', className)}
    >
      <ComboboxPrimitive.Input
        render={
          <InputGroupInput disabled={disabled} className='font-mono text-xs' />
        }
        {...props}
      />
      <InputGroupAddon align='inline-end'>
        {showTrigger && (
          <InputGroupButton
            nativeButton
            size='icon-xs'
            variant='ghost'
            render={<ComboboxTrigger aria-label={triggerAriaLabel} />}
            data-slot='input-group-button'
            className='rounded-none group-has-data-[slot=combobox-clear]/input-group:hidden data-pressed:bg-transparent'
            disabled={disabled}
          />
        )}
        {showClear && <ComboboxClear disabled={disabled} />}
      </InputGroupAddon>
      {children}
    </InputGroup>
  )
}

function ComboboxContent({
  className,
  side = 'bottom',
  sideOffset = 6,
  align = 'start',
  alignOffset = 0,
  anchor,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    'side' | 'align' | 'sideOffset' | 'alignOffset' | 'anchor'
  >) {
  const container = usePortalContainer()
  return (
    <ComboboxPrimitive.Portal container={container}>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className='isolate z-50'
      >
        <ComboboxPrimitive.Popup
          data-slot='combobox-content'
          data-chips={!!anchor}
          className={cn(
            'group/combobox-content bg-white text-black ring-0 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 *:data-[slot=input-group]:border-black *:data-[slot=input-group]:bg-white data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 relative max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) min-w-[calc(var(--anchor-width)+--spacing(7))] origin-(--transform-origin) overflow-hidden rounded-none border-2 border-black p-1 shadow-none duration-100 data-[chips=true]:min-w-(--anchor-width) *:data-[slot=input-group]:m-1 *:data-[slot=input-group]:mb-0 *:data-[slot=input-group]:h-8 *:data-[slot=input-group]:shadow-none',
            className
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot='combobox-list'
      className={cn(
        'no-scrollbar max-h-[min(calc(--spacing(72)---spacing(9)),calc(var(--available-height)---spacing(9)))] scroll-py-1 overflow-y-auto overscroll-contain p-1 data-empty:p-0',
        className
      )}
      {...props}
    />
  )
}

function ComboboxItem({
  className,
  children,
  ...props
}: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot='combobox-item'
      className={cn(
        "focus:bg-muted focus:text-foreground not-data-[variant=destructive]:focus:**:text-foreground data-highlighted:bg-muted data-highlighted:text-foreground not-data-[variant=destructive]:data-highlighted:**:text-foreground relative flex w-full cursor-pointer items-center gap-2 rounded-none py-1.5 pr-8 pl-2 text-xs font-mono text-black outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator
        render={
          <span className='pointer-events-none absolute right-2 flex size-4 items-center justify-center' />
        }
      >
        <Check className='pointer-events-none size-3.5' />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  )
}

function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
  return (
    <ComboboxPrimitive.Group
      data-slot='combobox-group'
      className={cn(className)}
      {...props}
    />
  )
}

function ComboboxLabel({
  className,
  ...props
}: ComboboxPrimitive.GroupLabel.Props) {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot='combobox-label'
      className={cn(
        'text-neutral-500 px-2 py-1 text-[10px] font-mono font-bold uppercase tracking-wider',
        className
      )}
      {...props}
    />
  )
}

function ComboboxCollection({ ...props }: ComboboxPrimitive.Collection.Props) {
  return (
    <ComboboxPrimitive.Collection data-slot='combobox-collection' {...props} />
  )
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot='combobox-empty'
      className={cn(
        'text-neutral-500 hidden w-full justify-center py-2 text-center text-xs font-mono group-data-empty/combobox-content:flex',
        className
      )}
      {...props}
    />
  )
}

function ComboboxSeparator({
  className,
  ...props
}: ComboboxPrimitive.Separator.Props) {
  return (
    <ComboboxPrimitive.Separator
      data-slot='combobox-separator'
      className={cn('bg-black/15 -mx-1 my-1 h-px', className)}
      {...props}
    />
  )
}

function ComboboxChips({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof ComboboxPrimitive.Chips> &
  ComboboxPrimitive.Chips.Props) {
  return (
    <ComboboxPrimitive.Chips
      data-slot='combobox-chips'
      className={cn(
        'border-black focus-within:border-black focus-within:ring-1 focus-within:ring-black flex min-h-8 flex-wrap items-center gap-1 rounded-none border bg-white px-2.5 py-1 text-xs font-mono transition-none has-data-[slot=combobox-chip]:px-1',
        className
      )}
      {...props}
    />
  )
}

function ComboboxChip({
  className,
  children,
  showRemove = true,
  ...props
}: ComboboxPrimitive.Chip.Props & {
  showRemove?: boolean
}) {
  return (
    <ComboboxPrimitive.Chip
      data-slot='combobox-chip'
      className={cn(
        'border border-black/30 bg-neutral-100 text-black flex h-[calc(--spacing(5.25))] w-fit items-center justify-center gap-1 rounded-none px-1.5 text-xs font-mono font-medium whitespace-nowrap has-disabled:pointer-events-none has-disabled:cursor-not-allowed has-disabled:opacity-50 has-data-[slot=combobox-chip-remove]:pr-0',
        className
      )}
      {...props}
    >
      {children}
      {showRemove && (
        <ComboboxPrimitive.ChipRemove
          render={
            <Button
              variant='ghost'
              size='icon-xs'
              className='rounded-none transition-none hover:bg-black hover:text-white'
            />
          }
          className='-ml-1 opacity-50 hover:opacity-100'
          data-slot='combobox-chip-remove'
        >
          <X className='pointer-events-none size-3' />
        </ComboboxPrimitive.ChipRemove>
      )}
    </ComboboxPrimitive.Chip>
  )
}

function ComboboxChipsInput({
  className,
  ...props
}: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      data-slot='combobox-chip-input'
      className={cn(
        'min-w-16 flex-1 outline-none font-mono text-xs',
        className
      )}
      {...props}
    />
  )
}

function useComboboxAnchor() {
  return React.useRef<HTMLDivElement | null>(null)
}

export {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxSeparator,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
  ComboboxTrigger,
  ComboboxValue,
  useComboboxAnchor,
}
