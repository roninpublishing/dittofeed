import {
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
} from "@mui/material";

// material-ui
import { MenuItem } from "../../../../menuItems/types";
import Link from "../../../../workspace/navigation";

// ==============================|| NAVIGATION - LIST ITEM ||============================== //

function MinimalNavItem({
  item,
  level,
  isSelected,
}: {
  level: number;
  item: MenuItem;
  isSelected: boolean;
}) {
  const Icon = item.icon;
  const description = item.disabled
    ? `Coming Soon: ${item.description}`
    : item.description;

  return (
    <Tooltip title={description} placement="right" arrow>
      <span>
        <ListItemButton
          href={item.url}
          disabled={item.disabled}
          target={item.external ? "_blank" : "_self"}
          rel={item.external ? "noopener noreferrer" : undefined}
          component={item.external ? "a" : Link}
          selected={isSelected}
          aria-current={isSelected ? "page" : undefined}
          sx={{
            minHeight: 36,
            borderRadius: 1,
            px: 1,
            py: 0.5,
            ml: level,
            "&.Mui-focusVisible": {
              outline: "2px solid",
              outlineColor: "primary.main",
              outlineOffset: -2,
            },
          }}
        >
          <ListItemIcon sx={{ minWidth: 28, "& svg": { fontSize: 18 } }}>
            <Icon />
          </ListItemIcon>
          <ListItemText
            primary={<Typography variant="body1">{item.title}</Typography>}
          />
        </ListItemButton>
      </span>
    </Tooltip>
  );
}

export default MinimalNavItem;
