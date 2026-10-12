/** Only a user's composer text can authorize an agent to save a Tandix skill. */
export function requestsSkillSave(text: string): boolean {
  const normalized = text.toLocaleLowerCase()
  const mentionsSkill = /技能|\bskills?\b/u.test(normalized)
  const asksToSave = /保存|存为|存成|存到|记成|沉淀|创建|生成|新建|\b(save|store|create|make|add)\b/u.test(normalized)
  const negatesSave = /(?:不要|别|无需|不用|暂不|先不|禁止)\s*(?:保存|存为|创建|生成)|\b(?:don['’]?t|do not|without)\s+(?:save|store|create|make|add)\b/u.test(normalized)
  const asksWhereSaved = /(?:保存|存到).{0,8}(?:哪里|哪儿|什么地方|哪个目录|哪儿了)|(?:保存|存到)在哪/u.test(normalized)
  const asksSaveStatus = /(?:技能.{0,12})?(?:保存|存好|创建).{0,6}(?:了吗|没有|成功吗|是否成功|为什么|怎么回事)/u.test(normalized)
  return mentionsSkill && asksToSave && !negatesSave && !asksWhereSaved && !asksSaveStatus
}
