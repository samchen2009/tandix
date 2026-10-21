/** Public display metadata only; never forward raw agent configuration or credentials. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.length > 0 ? value.slice(0, 200) : null
const choices = option => (Array.isArray(option?.options) ? option.options : []).filter(record)
  .flatMap(item => Array.isArray(item.options) ? item.options.filter(record) : [item])
  .filter(item => text(item.value)).slice(0, 500).map(item => ({ id: text(item.value), label: text(item.name) ?? text(item.value) }))

export function acpControls(backend, response = {}) {
  const options = Array.isArray(response.configOptions) ? response.configOptions.filter(record) : []
  const model = options.find(item => item.category === 'model' || item.id === 'model')
  const effort = options.find(item => ['thought_level', 'reasoning', 'reasoning_effort'].includes(item.category) || ['thought_level', 'reasoning', 'reasoning_effort'].includes(item.id))
  const legacy = backend === 'cursor' && !model && Array.isArray(response.modes?.availableModes)
    ? response.modes.availableModes.filter(record).filter(item => text(item.id)).slice(0, 500).map(item => ({ id: text(item.id), label: text(item.name) ?? text(item.id) })) : []
  return { model: model && text(model.id) && choices(model).length ? { method: 'session/set_config_option', id: text(model.id), choices: choices(model) }
    : legacy.length ? { method: 'session/set_mode', choices: legacy } : null,
    effort: effort && text(effort.id) && choices(effort).length ? { id: text(effort.id), choices: choices(effort) } : null }
}
export function acpConfiguration(backend, sessionId, response = {}, source = 'session') {
  const options = Array.isArray(response.configOptions) ? response.configOptions.filter(record) : []
  const find = categories => options.find(option => categories.includes(option.category) || categories.includes(option.id))
  const model = find(['model'])
  const mode = find(['mode'])
  const effort = find(['thought_level', 'reasoning', 'reasoning_effort'])
  const label = option => {
    const choices = (Array.isArray(option?.options) ? option.options : []).filter(record).flatMap(item => Array.isArray(item.options) ? item.options.filter(record) : [item])
    return text(choices.find(item => item.value === option?.currentValue)?.name) ?? text(option?.currentValue)
  }
  // This Cursor runtime exposes model presets through ACP's legacy modes field.
  const cursorMode = backend === 'cursor' && !model ? response.modes?.currentModeId : null
  const cursorLabel = Array.isArray(response.modes?.availableModes) ? response.modes.availableModes.find(item => record(item) && item.id === cursorMode)?.name : null
  return { backend, sessionId, source, modelId: text(model?.currentValue) ?? text(cursorMode),
    modelLabel: label(model) ?? text(cursorLabel) ?? (cursorMode === 'default' ? 'auto' : text(cursorMode)), provider: null,
    reasoningEffort: label(effort), reasoningEffortId: text(effort?.currentValue), mode: label(mode) ?? (backend === 'cursor' ? null : text(response.modes?.currentModeId)) }
}

export function codexConfiguration(sessionId, response = {}, source = 'session') {
  return { backend: 'codex', sessionId, source, modelId: text(response.model), modelLabel: text(response.model),
    provider: text(response.modelProvider), reasoningEffort: text(Object.hasOwn(response, 'reasoningEffort') ? response.reasoningEffort : response.effort),
    mode: text(response.collaborationMode?.mode),
    approvalPolicy: text(response.approvalPolicy), sandbox: text(response.sandbox?.type ?? response.sandboxPolicy?.type) }
}
