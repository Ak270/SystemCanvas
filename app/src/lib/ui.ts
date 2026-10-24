import { createContext, useContext } from 'react'
export const SearchCtx = createContext<() => void>(() => {})
export const useOpenSearch = () => useContext(SearchCtx)
