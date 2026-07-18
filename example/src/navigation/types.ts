import { type NavigatorScreenParams } from '@react-navigation/native';

export type ShopStackParamList = {
  ShopList: undefined;
  ProductDetail: { id: number; title: string };
};

export type RootTabParamList = {
  HomeTab: undefined;
  ShopTab: NavigatorScreenParams<ShopStackParamList> | undefined;
  CartTab: undefined;
  ToolsTab: undefined;
  SettingsTab: undefined;
};
