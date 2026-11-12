// EditableUserBubble — the edit-your-last-message control. ChatView.editLast (the rewind +
// resend) is not reached here; these pin the bubble's own contract with it: what it sends,
// when it stays open, and that an unchanged or cancelled edit never fires a rewind.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { EditableUserBubble, EDIT_CANCELLED } from './ChatView'

afterEach(cleanup)

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
const box = () => screen.getByRole('textbox') as HTMLTextAreaElement

describe('EditableUserBubble', () => {
  it('shows the text and no box until the pencil is pressed', () => {
    render(<EditableUserBubble text="hello" onEdit={async () => null} />)
    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    open()
    expect(box().value).toBe('hello')
  })

  it('Enter sends the edited text and closes on success', async () => {
    const onEdit = vi.fn(async () => null)
    render(<EditableUserBubble text="hello" onEdit={onEdit} />)
    open()
    fireEvent.change(box(), { target: { value: 'goodbye' } })
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    expect(onEdit).toHaveBeenCalledWith('goodbye')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('Shift+Enter does not send', async () => {
    const onEdit = vi.fn(async () => null)
    render(<EditableUserBubble text="hello" onEdit={onEdit} />)
    open()
    fireEvent.change(box(), { target: { value: 'goodbye' } })
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true }) })
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('an unchanged text cannot be sent', () => {
    render(<EditableUserBubble text="hello" onEdit={async () => null} />)
    open()
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('an error keeps the box open with the text and shows why', async () => {
    render(<EditableUserBubble text="hello" onEdit={async () => 'boom'} />)
    open()
    fireEvent.change(box(), { target: { value: 'goodbye' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(box().value).toBe('goodbye')
    expect(screen.getByText(/boom/)).toBeTruthy()
  })

  it('a cancelled restore dialog keeps the box open with no error', async () => {
    render(<EditableUserBubble text="hello" onEdit={async () => EDIT_CANCELLED} />)
    open()
    fireEvent.change(box(), { target: { value: 'goodbye' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(box().value).toBe('goodbye')
    expect(screen.queryByText(/⚠/)).toBeNull()
  })

  it('Escape cancels, restores the original text, and sends nothing', () => {
    const onEdit = vi.fn(async () => null)
    render(<EditableUserBubble text="hello" onEdit={onEdit} />)
    open()
    fireEvent.change(box(), { target: { value: 'goodbye' } })
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(onEdit).not.toHaveBeenCalled()
    open()
    expect(box().value).toBe('hello')
  })
})
