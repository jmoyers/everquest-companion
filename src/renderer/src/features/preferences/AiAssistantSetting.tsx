import { type JSX, useCallback, useEffect, useState } from 'react'
import { Box, Button, Checkbox, FormControlLabel, Stack, TextField, Typography } from '@mui/material'
import SmartToyIcon from '@mui/icons-material/SmartToy'
import { AI_DEFAULT_MODEL, AI_MODEL_OPTIONS, resolveAiModel } from '@shared/aiModels'
import type { PrefSection } from './PreferencesView'

export function aiAssistantSection(): PrefSection {
  return {
    id: 'ai-assistant',
    label: 'AI Assistant',
    icon: <SmartToyIcon fontSize="small" />,
    items: [
      {
        id: 'ai-config',
        label: 'Configuration',
        keywords: 'ai assistant openrouter api key token consent privacy model llm',
        content: <AiAssistantSetting />
      }
    ]
  }
}

function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <TextField
      select
      size="small"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      slotProps={{ select: { native: true } }}
      fullWidth
    >
      {AI_MODEL_OPTIONS.map((opt) => (
        <option key={opt.id} value={opt.id}>
          {opt.label}
        </option>
      ))}
    </TextField>
  )
}

export function AiAssistantSetting(): JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(AI_DEFAULT_MODEL)
  const [personalStyle, setPersonalStyle] = useState('')
  const [consent, setConsent] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.eq.getAiConfig().then((config) => {
      setApiKey(config.apiKey ?? '')
      setModel(resolveAiModel(config.model))
      if (config.personalStyle) setPersonalStyle(config.personalStyle)
      setConsent(config.consent)
    })
  }, [])

  const handleSave = useCallback(() => {
    if (!consent) return
    void window.eq.setAiConfig({ apiKey, consent, model, personalStyle }).then(() => {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }, [apiKey, consent, model, personalStyle])

  return (
    <Stack spacing={3} data-testid="pref-ai-assistant">
      <Stack spacing={0.5}>
        <Typography variant="body2" fontWeight="bold">OpenRouter API Key</Typography>
        <TextField
          size="small"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-or-v1-..."
          fullWidth
          data-testid="ai-api-key-input"
        />
        <Typography variant="caption" color="text.secondary">
          Required to connect. Get a key at{' '}
          <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" style={{ color: '#00e6e6' }}>
            openrouter.ai/keys
          </a>
          . Credits are only needed for [Good], [Better], and [Best]. [Free] is $0.
        </Typography>
      </Stack>

      <Stack spacing={0.5}>
        <Typography variant="body2" fontWeight="bold">Model</Typography>
        <ModelSelect value={model} onChange={setModel} />
        <Typography variant="caption" color="text.secondary" component="div">
          [Free] is $0 but rate-limited, and OpenRouter can drop a free model. [Good] is cheap paid.
          [Better] is the daily driver. [Best] is slowest and priciest. Unknown stored models fall
          back to DeepSeek Chat. Free list:{' '}
          <a
            href="https://openrouter.ai/collections/free-models"
            target="_blank"
            rel="noreferrer"
            style={{ color: '#00e6e6' }}
          >
            openrouter.ai/collections/free-models
          </a>
        </Typography>
      </Stack>

      <Stack spacing={0.5}>
        <Typography variant="body2" fontWeight="bold">Personal Style Instructions</Typography>
        <TextField
          size="small"
          multiline
          minRows={3}
          value={personalStyle}
          onChange={(e) => setPersonalStyle(e.target.value)}
          placeholder="e.g. Always call me Boss. Keep your answers under 3 sentences."
          fullWidth
        />
        <Typography variant="caption" color="text.secondary">
          Extra rules appended to the system prompt.
        </Typography>
      </Stack>

      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            data-testid="ai-consent-checkbox"
          />
        }
        label={<Typography variant="body2">I understand recap lines and what I type will be sent to OpenRouter.</Typography>}
      />

      <Box>
        <Button variant="contained" disabled={!consent || !apiKey} onClick={handleSave} data-testid="ai-save-button">
          {saved ? 'Saved!' : 'Save Configuration'}
        </Button>
      </Box>
    </Stack>
  )
}
