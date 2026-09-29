import { Draft } from './model'
import { renderComment, setStatus } from './render'

const params = new URLSearchParams(location.search)

const draft = new Draft(params.get('author') ?? 'anonymous', params.get('body') ?? '')
renderComment(draft)

setStatus(decodeURIComponent(location.hash.slice(1)))
