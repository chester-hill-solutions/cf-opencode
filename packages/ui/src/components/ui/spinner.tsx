import { cn } from "../../lib/utils"
import { useUiI18n } from "./i18n"
import { Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  const { t } = useUiI18n()
  return (
    <Loader2Icon data-slot="spinner" role="status" aria-label={t("loading")} className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
