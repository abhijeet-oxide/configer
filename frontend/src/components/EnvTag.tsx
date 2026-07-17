import { Tag } from "antd";
import { envHex } from "../theme";

// EnvTag is THE way an environment is named anywhere in the product: a pale
// tint of the environment's identity color (theme.ts envColors - production
// indigo, staging amber, development green) with a solid dot and colored
// text. One visual language for a load-bearing dimension; never a saturated
// solid chip, never danger-red for production.
export default function EnvTag({
  env,
  count,
  style,
}: {
  env?: string;
  /** optional instance count, rendered as "×N" */
  count?: number;
  style?: React.CSSProperties;
}) {
  const hex = envHex(env);
  return (
    <Tag
      style={{
        fontSize: 11,
        color: hex,
        background: `${hex}14`,
        borderColor: `${hex}55`,
        ...style,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          background: hex,
          display: "inline-block",
          marginInlineEnd: 6,
        }}
      />
      {env || "unspecified"}
      {count !== undefined ? ` ×${count}` : ""}
    </Tag>
  );
}
